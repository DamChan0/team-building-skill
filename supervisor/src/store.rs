use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::process::ProcessIdentity;
use crate::protocol::{TaskResult, TaskSpec};

#[derive(Clone, Debug)]
pub(crate) struct TaskSnapshot {
    pub(crate) request_id: String,
    pub(crate) spec: TaskSpec,
    pub(crate) state: String,
    pub(crate) result: Option<TaskResult>,
    pub(crate) error: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) session_file: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) created_ms: i64,
    pub(crate) updated_ms: i64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Completion<'a> {
    pub(crate) state: &'a str,
    pub(crate) result: Option<&'a TaskResult>,
    pub(crate) error: Option<&'a str>,
    pub(crate) session_id: Option<&'a str>,
    pub(crate) session_file: Option<&'a str>,
    pub(crate) model: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub(crate) struct OwnedTask {
    pub(crate) request_id: String,
    pub(crate) identity: Option<ProcessIdentity>,
}

pub(crate) struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    pub(crate) fn open(path: &std::path::Path) -> Result<Self> {
        let connection = Connection::open(path).context("opening supervisor database")?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS tasks (
              request_id TEXT PRIMARY KEY, spec TEXT NOT NULL,
              team TEXT NOT NULL, worker TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL,
              result TEXT, error TEXT, session_id TEXT, session_file TEXT, model TEXT,
              pid INTEGER, starttime INTEGER, pgid INTEGER, boot_id TEXT, fence_released INTEGER NOT NULL DEFAULT 0,
              created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS tasks_team_task ON tasks(team, task);
            CREATE INDEX IF NOT EXISTS tasks_worker_state ON tasks(team, worker, state);
            CREATE TABLE IF NOT EXISTS events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES tasks(request_id), state TEXT NOT NULL, data TEXT NOT NULL, created_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS acknowledgements (request_id TEXT PRIMARY KEY REFERENCES tasks(request_id), seq INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS events_request_seq ON events(request_id, seq);")?;
        for column in [
            "pid INTEGER",
            "starttime INTEGER",
            "pgid INTEGER",
            "boot_id TEXT",
        ] {
            let _ = connection.execute(&format!("ALTER TABLE tasks ADD COLUMN {column}"), []);
        }
        let _ = connection.execute(
            "ALTER TABLE tasks ADD COLUMN fence_released INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = connection.execute_batch("ALTER TABLE tasks DROP COLUMN canonical_spec");
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.recover_running()?;
        Ok(store)
    }

    pub(crate) fn submit(&self, request_id: &str, spec: &TaskSpec) -> Result<(TaskSnapshot, bool)> {
        let canonical = serde_json::to_string(spec)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        if let Some((existing, existing_canonical)) = snapshot_in(&tx, request_id)? {
            if existing_canonical != canonical {
                return Err(anyhow!("request_conflict"));
            }
            return Ok((existing, false));
        }
        if tx
            .query_row(
                "SELECT request_id FROM tasks WHERE team=?1 AND task=?2",
                params![spec.team, spec.task],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some()
        {
            return Err(anyhow!("task_conflict"));
        }
        let queued: i64 = tx.query_row(
            "SELECT COUNT(*) FROM tasks WHERE state='queued'",
            [],
            |row| row.get(0),
        )?;
        if queued >= 1024 {
            return Err(anyhow!("queue_full"));
        }
        let now = now_ms();
        tx.execute("INSERT INTO tasks(request_id,spec,team,worker,task,state,created_ms,updated_ms) VALUES(?1,?2,?3,?4,?5,'queued',?6,?6)", params![request_id, canonical, spec.team, spec.worker, spec.task, now])?;
        append_event(&tx, request_id, "accepted", json!({"state":"queued"}), now)?;
        tx.commit()?;
        snapshot_in(&connection, request_id)?
            .map(|(snapshot, _)| (snapshot, true))
            .ok_or_else(|| anyhow!("inserted task disappeared"))
    }

    pub(crate) fn get(&self, request_id: &str) -> Result<Option<TaskSnapshot>> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        snapshot_in(&connection, request_id).map(|item| item.map(|(snapshot, _)| snapshot))
    }

    pub(crate) fn next_queued(&self) -> Result<Option<TaskSnapshot>> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let id = connection.query_row("SELECT t.request_id FROM tasks t WHERE t.state='queued' AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.team=t.team AND r.worker=t.worker AND (r.state='running' OR (r.state='unknown' AND r.fence_released=0))) ORDER BY t.rowid LIMIT 1", [], |row| row.get::<_, String>(0)).optional()?;
        id.map_or(Ok(None), |id| {
            snapshot_in(&connection, &id).map(|item| item.map(|(snapshot, _)| snapshot))
        })
    }

    pub(crate) fn mark_running(&self, request_id: &str) -> Result<Option<TaskSnapshot>> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        let Some((mut task, _)) = snapshot_in(&tx, request_id)? else {
            return Ok(None);
        };
        if task.state != "queued" {
            return Ok(None);
        }
        let active: i64 = tx.query_row("SELECT COUNT(*) FROM tasks WHERE team=?1 AND worker=?2 AND (state='running' OR (state='unknown' AND fence_released=0))", params![task.spec.team, task.spec.worker], |row| row.get(0))?;
        if active != 0 {
            return Ok(None);
        }
        if let Some((session_id, session_file)) =
            latest_session(&tx, &task.spec.team, &task.spec.worker)?
        {
            if task
                .spec
                .session_id
                .as_ref()
                .is_some_and(|value| value != &session_id)
                || task
                    .spec
                    .session_file
                    .as_ref()
                    .is_some_and(|value| Some(value) != session_file.as_ref())
            {
                tx.execute("UPDATE tasks SET state='blocked',error='session_pin_conflict',updated_ms=?2 WHERE request_id=?1", params![request_id, now_ms()])?;
                append_event(
                    &tx,
                    request_id,
                    "blocked",
                    json!({"state":"blocked","error":"session_pin_conflict"}),
                    now_ms(),
                )?;
                tx.commit()?;
                return Ok(None);
            }
            task.spec.session_id = Some(session_id);
            task.spec.session_file = session_file;
            if let Err(error) = apply_resume(&mut task.spec) {
                tx.execute(
                    "UPDATE tasks SET state='blocked',error=?2,updated_ms=?3 WHERE request_id=?1",
                    params![request_id, error.to_string(), now_ms()],
                )?;
                append_event(
                    &tx,
                    request_id,
                    "blocked",
                    json!({"state":"blocked","error":error.to_string()}),
                    now_ms(),
                )?;
                tx.commit()?;
                return Ok(None);
            }
        } else if task.spec.session_id.is_some() || task.spec.session_file.is_some() {
            // The adapter validates the explicit pin; never substitute a fresh/latest session.
        }
        let changed = tx.execute(
            "UPDATE tasks SET state='running',updated_ms=?2 WHERE request_id=?1 AND state='queued'",
            params![request_id, now_ms()],
        )?;
        if changed == 1 {
            append_event(
                &tx,
                request_id,
                "running",
                json!({"state":"running"}),
                now_ms(),
            )?;
            tx.commit()?;
            Ok(Some(task))
        } else {
            Ok(None)
        }
    }

    pub(crate) fn event(&self, request_id: &str, state: &str, data: Value) -> Result<()> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        append_event(&tx, request_id, state, data, now_ms())?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn owned(&self, request_id: &str, identity: &ProcessIdentity) -> Result<()> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        tx.execute("UPDATE tasks SET pid=?2,starttime=?3,pgid=?4,boot_id=?5,updated_ms=?6 WHERE request_id=?1", params![request_id, identity.pid, identity.starttime, identity.pgid, identity.boot_id, now_ms()])?;
        append_event(
            &tx,
            request_id,
            "owned",
            json!({"pid":identity.pid,"starttime":identity.starttime,"pgid":identity.pgid}),
            now_ms(),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn session(
        &self,
        request_id: &str,
        session_id: &str,
        session_file: Option<&str>,
    ) -> Result<()> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        tx.execute(
            "UPDATE tasks SET session_id=?2,session_file=?3,updated_ms=?4 WHERE request_id=?1",
            params![request_id, session_id, session_file, now_ms()],
        )?;
        append_event(
            &tx,
            request_id,
            "session",
            json!({"session_id":session_id,"session_file":session_file}),
            now_ms(),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn complete(&self, request_id: &str, completion: Completion<'_>) -> Result<()> {
        let result = completion.result.map(serde_json::to_string).transpose()?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        let changed = tx.execute("UPDATE tasks SET state=?2,result=?3,error=?4,session_id=COALESCE(?5,session_id),session_file=COALESCE(?6,session_file),model=?7,updated_ms=?8 WHERE request_id=?1 AND state IN ('running','unknown')", params![request_id,completion.state,result,completion.error,completion.session_id,completion.session_file,completion.model,now_ms()])?;
        if changed == 1 {
            append_event(
                &tx,
                request_id,
                completion.state,
                json!({"state":completion.state,"error":completion.error}),
                now_ms(),
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn wait(
        &self,
        request_id: &str,
        after: i64,
    ) -> Result<(Vec<Value>, bool, TaskSnapshot)> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let mut statement = connection.prepare("SELECT seq,state,data FROM events WHERE request_id=?1 AND seq>?2 ORDER BY seq LIMIT 33")?;
        let rows = statement.query_map(params![request_id, after], |row| {
            let data: String = row.get(2)?;
            Ok(json!({"seq":row.get::<_,i64>(0)?,"request_id":request_id,"state":row.get::<_,String>(1)?,"data":serde_json::from_str::<Value>(&data).unwrap_or(json!({}))}))
        })?;
        let events: Vec<_> = rows.collect::<rusqlite::Result<_>>()?;
        let more = events.len() > 32;
        let snapshot = snapshot_in(&connection, request_id)?
            .map(|item| item.0)
            .ok_or_else(|| anyhow!("not_found"))?;
        Ok((events.into_iter().take(32).collect(), more, snapshot))
    }

    pub(crate) fn acknowledge(&self, request_id: &str, seq: i64) -> Result<()> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        connection.execute("INSERT INTO acknowledgements(request_id,seq) VALUES(?1,?2) ON CONFLICT(request_id) DO UPDATE SET seq=MAX(seq,excluded.seq)", params![request_id,seq])?;
        Ok(())
    }

    pub(crate) fn status(
        &self,
        team: Option<&str>,
        after: i64,
        limit: usize,
    ) -> Result<(Vec<Value>, i64, bool, i64)> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let mut workers = Vec::new();
        let mut statement = connection.prepare(
            "WITH ranked AS (
                SELECT rowid AS seq,team,worker,state,request_id,task,session_id,session_file,fence_released,
                    COUNT(*) OVER (PARTITION BY team,worker) AS assignments,
                    ROW_NUMBER() OVER (PARTITION BY team,worker ORDER BY
                        CASE WHEN state='running' OR (state='unknown' AND fence_released=0) THEN 0 WHEN state='queued' THEN 1 ELSE 2 END,
                        CASE WHEN state='queued' THEN rowid END ASC,rowid DESC) AS rank
                FROM tasks WHERE ?1 IS NULL OR team=?1
            )
            SELECT seq,team,worker,state,request_id,task,
                COALESCE(session_id,(SELECT session_id FROM tasks h WHERE h.team=ranked.team AND h.worker=ranked.worker AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1)),
                COALESCE(session_file,(SELECT session_file FROM tasks h WHERE h.team=ranked.team AND h.worker=ranked.worker AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1)),fence_released,assignments
            FROM ranked WHERE rank=1 AND seq>?2 ORDER BY seq LIMIT ?3"
        )?;
        let rows = statement.query_map(params![team, after, limit as i64 + 1], status_row)?;
        for row in rows {
            workers.push(row?);
        }
        let more = workers.len() > limit;
        workers.truncate(limit);
        let next_after = workers
            .last()
            .and_then(|value| value.get("accepted_seq"))
            .and_then(Value::as_i64)
            .unwrap_or(after);
        for worker in &mut workers {
            worker
                .as_object_mut()
                .map(|object| object.remove("accepted_seq"));
        }
        let queued = if let Some(team) = team {
            connection.query_row(
                "SELECT COUNT(*) FROM tasks WHERE team=?1 AND state='queued'",
                [team],
                |row| row.get(0),
            )?
        } else {
            connection.query_row(
                "SELECT COUNT(*) FROM tasks WHERE state='queued'",
                [],
                |row| row.get(0),
            )?
        };
        Ok((workers, next_after, more, queued))
    }

    pub(crate) fn stop_queued(&self, team: &str, worker: &str) -> Result<()> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        let mut statement = tx.prepare(
            "SELECT request_id FROM tasks WHERE team=?1 AND worker=?2 AND state='queued'",
        )?;
        let ids = statement
            .query_map(params![team, worker], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for id in ids {
            tx.execute("UPDATE tasks SET state='blocked',error='stopped',updated_ms=?2 WHERE request_id=?1", params![id, now_ms()])?;
            append_event(
                &tx,
                &id,
                "blocked",
                json!({"state":"blocked","error":"stopped"}),
                now_ms(),
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn owned_for(&self, team: &str, worker: &str) -> Result<Vec<OwnedTask>> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let mut statement = connection.prepare("SELECT request_id,pid,starttime,pgid,boot_id FROM tasks WHERE team=?1 AND worker=?2 AND (state='running' OR (state='unknown' AND fence_released=0))")?;
        let owned = statement
            .query_map(params![team, worker], |row| {
                let pid: Option<u32> = row.get(1)?;
                let starttime: Option<u64> = row.get(2)?;
                let pgid: Option<i32> = row.get(3)?;
                let boot_id: Option<String> = row.get(4)?;
                let identity = match (pid, starttime, pgid, boot_id) {
                    (Some(pid), Some(starttime), Some(pgid), Some(boot_id)) => {
                        Some(ProcessIdentity {
                            pid,
                            starttime,
                            pgid,
                            boot_id,
                        })
                    }
                    _ => None,
                };
                Ok(OwnedTask {
                    request_id: row.get(0)?,
                    identity,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into);
        owned
    }
    pub(crate) fn release_unknown_fence(&self, request_id: &str) -> Result<()> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        if tx.execute("UPDATE tasks SET fence_released=1,updated_ms=?2 WHERE request_id=?1 AND state='unknown'", params![request_id, now_ms()])? == 1 {
            append_event(&tx, request_id, "stopped", json!({"state":"unknown","fence_released":true}), now_ms())?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn mark_stopped(&self, request_id: &str) -> Result<()> {
        self.complete(
            request_id,
            Completion {
                state: "blocked",
                result: None,
                error: Some("stopped"),
                session_id: None,
                session_file: None,
                model: None,
            },
        )
    }

    fn recover_running(&self) -> Result<()> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        let tx = connection.transaction()?;
        let mut statement = tx.prepare("SELECT request_id FROM tasks WHERE state='running'")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for id in ids {
            tx.execute("UPDATE tasks SET state='unknown',error='daemon_restart',updated_ms=?2 WHERE request_id=?1", params![id, now_ms()])?;
            append_event(
                &tx,
                &id,
                "unknown",
                json!({"state":"unknown","error":"daemon_restart"}),
                now_ms(),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

fn status_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"accepted_seq":row.get::<_,i64>(0)?,"team":row.get::<_,String>(1)?,"worker":row.get::<_,String>(2)?,"state":row.get::<_,String>(3)?,"request_id":row.get::<_,String>(4)?,"task":row.get::<_,String>(5)?,"session_id":row.get::<_,Option<String>>(6)?,"session_file":row.get::<_,Option<String>>(7)?,"fence_released":row.get::<_,bool>(8)?,"assignments":row.get::<_,i64>(9)?}),
    )
}

fn latest_session(
    connection: &Connection,
    team: &str,
    worker: &str,
) -> Result<Option<(String, Option<String>)>> {
    connection.query_row("SELECT session_id,session_file FROM tasks WHERE team=?1 AND worker=?2 AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1", params![team, worker], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(Into::into)
}

fn apply_resume(spec: &mut TaskSpec) -> Result<()> {
    for flag in ["--resume", "--session-id"] {
        while let Some(index) = spec.argv.iter().position(|argument| argument == flag) {
            if index + 1 >= spec.argv.len() {
                return Err(anyhow!("native session flag has no value"));
            }
            spec.argv.drain(index..index + 2);
        }
    }
    match spec.harness.as_str() {
        "omp" => {
            let session_file = spec
                .session_file
                .clone()
                .ok_or_else(|| anyhow!("OMP session file missing"))?;
            if !spec.argv.iter().any(|argument| argument == "--resume") {
                spec.argv.extend(["--resume".into(), session_file]);
            }
        }
        "claude" => {
            let session_id = spec
                .session_id
                .clone()
                .ok_or_else(|| anyhow!("Claude session identity missing"))?;
            if !spec.argv.iter().any(|argument| argument == "--resume") {
                spec.argv.extend(["--resume".into(), session_id]);
            }
        }
        "codex" => {}
        _ => return Err(anyhow!("unsupported native harness")),
    }
    Ok(())
}

fn snapshot_in(
    connection: &Connection,
    request_id: &str,
) -> Result<Option<(TaskSnapshot, String)>> {
    connection.query_row("SELECT request_id,spec,state,result,error,session_id,session_file,model,created_ms,updated_ms FROM tasks WHERE request_id=?1", [request_id], |row| {
        let spec: String = row.get(1)?;
        let result: Option<String> = row.get(3)?;
        Ok((TaskSnapshot { request_id: row.get(0)?, spec: serde_json::from_str(&spec).map_err(|error| rusqlite::Error::FromSqlConversionFailure(spec.len(), rusqlite::types::Type::Text, Box::new(error)))?, state: row.get(2)?, result: result.map(|value| serde_json::from_str(&value)).transpose().map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)))?, error: row.get(4)?, session_id: row.get(5)?, session_file: row.get(6)?, model: row.get(7)?, created_ms: row.get(8)?, updated_ms: row.get(9)? }, spec))
    }).optional().map_err(Into::into)
}

fn append_event(
    tx: &Transaction<'_>,
    request_id: &str,
    state: &str,
    data: Value,
    now: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO events(request_id,state,data,created_ms) VALUES(?1,?2,?3,?4)",
        params![request_id, state, serde_json::to_string(&data)?, now],
    )?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().try_into().unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn spec(task: &str) -> TaskSpec {
        TaskSpec {
            team_dir: "/tmp/team".into(),
            team: "team".into(),
            worker: "worker".into(),
            task: task.into(),
            kind: "task".into(),
            cwd: "/tmp".into(),
            harness: "omp".into(),
            argv: vec!["omp".into()],
            env: BTreeMap::new(),
            prompt: "prompt".into(),
            model: None,
            thinking: None,
            session_id: None,
            session_file: None,
            log: "/tmp/log".into(),
            idle_timeout_ms: 1,
            max_timeout_ms: 1,
        }
    }
    #[test]
    fn deduplicates_and_dispatches_fifo() {
        let path =
            std::env::temp_dir().join(format!("team-supervisor-{}.sqlite", uuid::Uuid::new_v4()));
        let store = Store::open(&path).unwrap();
        let first = "00000000-0000-4000-8000-000000000001";
        let second = "00000000-0000-4000-8000-000000000002";
        assert!(store.submit(first, &spec("first")).unwrap().1);
        assert!(!store.submit(first, &spec("first")).unwrap().1);
        assert_eq!(store.next_queued().unwrap().unwrap().request_id, first);
        assert!(store.mark_running(first).unwrap().is_some());
        let mut second_spec = spec("second");
        second_spec.worker = "other".into();
        assert!(store.submit(second, &second_spec).unwrap().1);
        assert_eq!(store.next_queued().unwrap().unwrap().request_id, second);
        drop(store);
        let _ = std::fs::remove_file(path);
    }
}
