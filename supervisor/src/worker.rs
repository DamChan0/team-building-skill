use std::{io, path::Path, process::Stdio, time::Duration};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, watch},
    time::{sleep, timeout, Instant},
};

use crate::{
    process::{capture, group_gone, terminate, ProcessIdentity},
    protocol::{TaskResult, TaskSpec, WorkerEvent, WorkerOutcome, MAX_FRAME, MAX_TEXT},
};

const LOG_LIMIT: u64 = 8 * 1024 * 1024;

pub(crate) async fn execute(
    request_id: &str,
    spec: &TaskSpec,
    mut cancel: watch::Receiver<bool>,
    events: mpsc::Sender<WorkerEvent>,
) -> WorkerOutcome {
    if *cancel.borrow() {
        return failed("cancelled before native spawn".into(), spec);
    }
    let mut child = match spawn(spec) {
        Ok(child) => child,
        Err(error) => return failed(error.to_string(), spec),
    };
    let identity = match child
        .id()
        .ok_or_else(|| anyhow!("native PID unavailable"))
        .and_then(capture)
    {
        Ok(identity) => identity,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return failed(error.to_string(), spec);
        }
    };
    if events
        .send(WorkerEvent::Owned {
            pid: identity.pid,
            starttime: identity.starttime,
            pgid: identity.pgid,
        })
        .await
        .is_err()
    {
        let _ = terminate(&identity).await;
        let _ = child.wait().await;
        return failed("event receiver closed".into(), spec);
    }
    let stderr = child.stderr.take();
    let mut stderr_task = tokio::spawn(async move {
        let Some(mut stderr) = stderr else {
            return String::new();
        };
        let mut bytes = [0_u8; 8192];
        let mut kept = String::new();
        while let Ok(read) = stderr.read(&mut bytes).await {
            if read == 0 {
                break;
            }
            retain(&mut kept, &String::from_utf8_lossy(&bytes[..read]));
        }
        kept
    });
    let outcome = match spec.harness.as_str() {
        "omp" => omp(request_id, spec, &mut child, &mut cancel, &events).await,
        "claude" => claude(request_id, spec, &mut child, &mut cancel, &events).await,
        "codex" => codex(request_id, spec, &mut child, &mut cancel, &events).await,
        _ => Err(anyhow!("unsupported native harness")),
    };
    let stopped = stop_and_reap(&mut child, &identity).await;
    let stderr = match timeout(Duration::from_secs(2), &mut stderr_task).await {
        Ok(Ok(stderr)) => stderr,
        _ => {
            stderr_task.abort();
            String::new()
        }
    };
    match outcome {
        Ok(outcome) if stopped => outcome,
        Ok(_) => unknown(
            "native process group could not be confirmed stopped".into(),
            spec,
        ),
        Err(error) if stopped => {
            let detail = if stderr.is_empty() {
                error.to_string()
            } else {
                format!("{error}: {stderr}")
            };
            failed(detail, spec)
        }
        Err(error) => unknown(error.to_string(), spec),
    }
}

fn spawn(spec: &TaskSpec) -> Result<Child> {
    let (program, args) = spec
        .argv
        .split_first()
        .ok_or_else(|| anyhow!("native argv is empty"))?;
    // SAFETY: reads this process's PID before fork for the parent-death race check below.
    let parent_pid = unsafe { libc::getpid() };
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(&spec.env);
    unsafe {
        command.pre_exec(move || {
            // SAFETY: runs only in the freshly forked child before exec; no Rust state is shared afterwards.
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: Linux prctl only sets the child-death signal for this child process.
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: prevents the fork/prctl race from leaving an orphaned child.
            if libc::getppid() != parent_pid {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
    Ok(command.spawn()?)
}

async fn omp(
    request_id: &str,
    spec: &TaskSpec,
    child: &mut Child,
    cancel: &mut watch::Receiver<bool>,
    events: &mpsc::Sender<WorkerEvent>,
) -> Result<WorkerOutcome> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("OMP stdin unavailable"))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("OMP stdout unavailable"))?,
    );
    let max = Instant::now() + Duration::from_millis(spec.max_timeout_ms);
    let mut idle = Instant::now() + Duration::from_millis(spec.idle_timeout_ms);
    let mut state_checked = false;
    let mut accepted = false;
    let mut prompt_completed = false;
    let mut session = (None, None);
    loop {
        let frame = parse_frame(&next_line(&mut stdout, cancel, idle.min(max)).await?)?;
        idle = Instant::now() + Duration::from_millis(spec.idle_timeout_ms);
        match frame.get("type").and_then(Value::as_str) {
            Some("ready") => {
                if frame.get("protocolVersion").and_then(Value::as_u64) != Some(1)
                    || !frame
                        .get("supportedProtocolVersions")
                        .and_then(Value::as_array)
                        .is_some_and(|versions| versions.iter().any(|v| v.as_u64() == Some(1)))
                {
                    return Err(anyhow!("OMP v1 protocol unavailable"));
                }
                send(&mut stdin, &json!({"id":"state","type":"get_state"})).await?;
            }
            Some("response") if frame.get("id").and_then(Value::as_str) == Some("state") => {
                if frame.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(anyhow!("OMP get_state rejected"));
                }
                session = session_from_state(frame.get("data"));
                ensure_session_id(spec, &session.0)?;
                ensure_session_file(spec, &session.1)?;
                emit_session(events, &session).await?;
                state_checked = true;
                send(
                    &mut stdin,
                    &json!({"id":request_id,"type":"prompt","message":spec.prompt}),
                )
                .await?;
            }
            Some("response") if frame.get("id").and_then(Value::as_str) == Some(request_id) => {
                if !state_checked || frame.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(anyhow!("OMP rejected prompt"));
                }
                accepted = true;
                emit(events, WorkerEvent::Started).await?;
            }
            Some("prompt_result")
                if frame.get("id").and_then(Value::as_str) == Some(request_id) =>
            {
                if frame.get("status").and_then(Value::as_str) != Some("completed") {
                    return Err(anyhow!("OMP provider error"));
                }
                prompt_completed = true;
                if frame.get("sessionSettled").and_then(Value::as_bool) == Some(true) {
                    send(&mut stdin, &json!({"id":"settled","type":"get_state"})).await?;
                }
            }
            Some("session_settled") if prompt_completed => {
                send(&mut stdin, &json!({"id":"settled","type":"get_state"})).await?
            }
            Some("response") if frame.get("id").and_then(Value::as_str) == Some("settled") => {
                if !accepted
                    || !prompt_completed
                    || frame.pointer("/data/isSettled").and_then(Value::as_bool) != Some(true)
                {
                    return Err(anyhow!("OMP session did not settle"));
                }
                send(
                    &mut stdin,
                    &json!({"id":"result","type":"get_last_assistant_text"}),
                )
                .await?;
            }
            Some("response") if frame.get("id").and_then(Value::as_str) == Some("result") => {
                if frame.get("success").and_then(Value::as_bool) != Some(true) {
                    return Err(anyhow!("OMP final result rejected"));
                }
                let result = parse_result(
                    frame
                        .pointer("/data/text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("OMP final result missing"))?,
                )?;
                append_ui(spec, &result.summary);
                return Ok(success(result, session.0, session.1, spec));
            }
            _ => {}
        }
    }
}

async fn claude(
    request_id: &str,
    spec: &TaskSpec,
    child: &mut Child,
    cancel: &mut watch::Receiver<bool>,
    events: &mpsc::Sender<WorkerEvent>,
) -> Result<WorkerOutcome> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Claude stdin unavailable"))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Claude stdout unavailable"))?,
    );
    send(
        &mut stdin,
        &json!({"type":"user","uuid":request_id,"message":{"role":"user","content":spec.prompt}}),
    )
    .await?;
    let max = Instant::now() + Duration::from_millis(spec.max_timeout_ms);
    let mut idle = Instant::now() + Duration::from_millis(spec.idle_timeout_ms);
    let mut accepted = false;
    let mut observed_session = false;
    let mut session = (spec.session_id.clone(), spec.session_file.clone());
    loop {
        let frame = parse_frame(&next_line(&mut stdout, cancel, idle.min(max)).await?)?;
        idle = Instant::now() + Duration::from_millis(spec.idle_timeout_ms);
        if !accepted
            && frame.get("type").and_then(Value::as_str) == Some("user")
            && frame
                .get("uuid")
                .and_then(Value::as_str)
                .is_none_or(|uuid| uuid == request_id)
        {
            accepted = true;
            emit(events, WorkerEvent::Started).await?;
        }
        if let Some(id) = frame.get("session_id").and_then(Value::as_str) {
            observed_session = true;
            session.0 = Some(id.into());
            ensure_session_id(spec, &session.0)?;
            emit_session(events, &session).await?;
        }
        // Final structured output must never be exposed before strict validation.
        if frame.get("type").and_then(Value::as_str) == Some("result") {
            if !accepted {
                return Err(anyhow!("Claude did not accept prompt"));
            }
            if frame.get("subtype").and_then(Value::as_str) != Some("success") {
                return Err(anyhow!("Claude provider error"));
            }
            if let Some(id) = frame.get("session_id").and_then(Value::as_str) {
                observed_session = true;
                session.0 = Some(id.into());
            }
            if !observed_session {
                return Err(anyhow!("Claude session identity missing"));
            }
            ensure_session_id(spec, &session.0)?;
            let result = if let Some(value) = frame.get("structured_output") {
                parse_result_value(value)?
            } else {
                parse_result(
                    frame
                        .get("result")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("Claude result missing"))?,
                )?
            };
            append_ui(spec, &result.summary);
            return Ok(success(result, session.0, session.1, spec));
        }
    }
}

async fn codex(
    _request_id: &str,
    spec: &TaskSpec,
    child: &mut Child,
    cancel: &mut watch::Receiver<bool>,
    events: &mpsc::Sender<WorkerEvent>,
) -> Result<WorkerOutcome> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Codex stdin unavailable"))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Codex stdout unavailable"))?,
    );
    send(&mut stdin, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"team-supervisor","version":"1"},"capabilities":{}}})).await?;
    let max = Instant::now() + Duration::from_millis(spec.max_timeout_ms);
    let mut idle = Instant::now() + Duration::from_millis(spec.idle_timeout_ms);
    let mut thread: Option<String> = None;
    let mut session_file = None;
    let mut turn: Option<String> = None;
    let mut final_text = None;
    loop {
        let frame = parse_frame(&next_line(&mut stdout, cancel, idle.min(max)).await?)?;
        idle = Instant::now() + Duration::from_millis(spec.idle_timeout_ms);
        if frame.get("error").is_some() {
            return Err(anyhow!("Codex JSON-RPC error"));
        }
        if frame.get("id").and_then(Value::as_i64) == Some(1) {
            send(
                &mut stdin,
                &json!({"jsonrpc":"2.0","method":"initialized","params":{}}),
            )
            .await?;
            let (method, params) = spec.session_id.as_ref().map_or(
                ("thread/start", json!({"cwd":spec.cwd,"model":spec.model})),
                |id| ("thread/resume", json!({"threadId":id})),
            );
            send(
                &mut stdin,
                &json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}),
            )
            .await?;
        } else if frame.get("id").and_then(Value::as_i64) == Some(2) {
            let id = frame
                .pointer("/result/thread/id")
                .and_then(Value::as_str)
                .or_else(|| frame.pointer("/result/threadId").and_then(Value::as_str))
                .ok_or_else(|| anyhow!("Codex thread identity missing"))?
                .to_owned();
            session_file = frame
                .pointer("/result/thread/path")
                .and_then(Value::as_str)
                .map(str::to_owned);
            ensure_session_id(spec, &Some(id.clone()))?;
            ensure_session_file(spec, &session_file)?;
            thread = Some(id.clone());
            emit(
                events,
                WorkerEvent::Session {
                    session_id: id.clone(),
                    session_file: session_file.clone(),
                },
            )
            .await?;
            send(&mut stdin, &json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":id,"input":[{"type":"text","text":spec.prompt}],"model":spec.model,"effort":spec.thinking,"outputSchema":result_schema()}})).await?;
        } else if frame.get("id").and_then(Value::as_i64) == Some(3) {
            turn = Some(
                frame
                    .pointer("/result/turn/id")
                    .and_then(Value::as_str)
                    .or_else(|| frame.pointer("/result/id").and_then(Value::as_str))
                    .ok_or_else(|| anyhow!("Codex turn identity missing"))?
                    .into(),
            );
            emit(events, WorkerEvent::Started).await?;
        } else if let Some(method) = frame.get("method").and_then(Value::as_str) {
            if frame.get("id").is_some() {
                send(&mut stdin, &json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32000,"message":"interactive requests unsupported"}})).await?;
                return Err(anyhow!("Codex requires interactive approval"));
            }
            let matching = frame.pointer("/params/threadId").and_then(Value::as_str)
                == thread.as_deref()
                && frame
                    .pointer("/params/turnId")
                    .or_else(|| frame.pointer("/params/turn/id"))
                    .and_then(Value::as_str)
                    == turn.as_deref();
            if method == "item/completed" && matching {
                if let Some(text) = frame
                    .pointer("/params/item")
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                    .and_then(assistant_text)
                {
                    if text.len() > MAX_TEXT {
                        return Err(anyhow!("Codex final result exceeds limit"));
                    }
                    final_text = Some(text.to_owned());
                }
            } else if method == "turn/completed" && matching {
                if frame.pointer("/params/turn/status").and_then(Value::as_str) != Some("completed")
                {
                    return Err(anyhow!("Codex turn failed"));
                }
                let result = parse_result(
                    final_text
                        .as_deref()
                        .ok_or_else(|| anyhow!("Codex final assistant result missing"))?,
                )?;
                append_ui(spec, &result.summary);
                return Ok(success(result, thread, session_file, spec));
            }
        }
    }
}

async fn next_line(
    stdout: &mut BufReader<tokio::process::ChildStdout>,
    cancel: &mut watch::Receiver<bool>,
    deadline: Instant,
) -> Result<String> {
    let mut bytes = Vec::with_capacity(1024);
    loop {
        let chunk = tokio::select! {
            changed = cancel.changed() => { changed?; return Err(anyhow!("cancelled")); }
            _ = sleep_until(deadline) => return Err(anyhow!("native timeout")),
            chunk = stdout.fill_buf() => chunk?,
        };
        if chunk.is_empty() {
            return Err(anyhow!("native stdout closed"));
        }
        let count = chunk
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(chunk.len(), |index| index + 1);
        if bytes.len().saturating_add(count) > MAX_FRAME {
            return Err(anyhow!("native frame exceeds limit"));
        }
        let newline = chunk[count - 1] == b'\n';
        bytes.extend_from_slice(&chunk[..count]);
        stdout.consume(count);
        if newline {
            bytes.pop();
            return String::from_utf8(bytes).map_err(Into::into);
        }
    }
}

async fn sleep_until(deadline: Instant) {
    sleep(deadline.saturating_duration_since(Instant::now())).await
}
async fn send(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME {
        return Err(anyhow!("outgoing frame exceeds limit"));
    }
    stdin.write_all(&bytes).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}
fn parse_frame(line: &str) -> Result<Value> {
    if line.len() > MAX_FRAME {
        return Err(anyhow!("native frame exceeds limit"));
    }
    let value: Value = serde_json::from_str(line)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("native frame is not an object"))?;
    let typed = object.get("type").and_then(Value::as_str).is_some()
        || object.get("jsonrpc").and_then(Value::as_str) == Some("2.0");
    if !typed {
        return Err(anyhow!("native frame lacks a protocol envelope"));
    }
    Ok(value)
}
fn parse_result(text: &str) -> Result<TaskResult> {
    if text.len() > MAX_TEXT {
        return Err(anyhow!("native result exceeds limit"));
    }
    let result: TaskResult = serde_json::from_str(text)?;
    result
        .valid()
        .then_some(result)
        .ok_or_else(|| anyhow!("invalid task result"))
}
fn parse_result_value(value: &Value) -> Result<TaskResult> {
    if serde_json::to_vec(value)?.len() > MAX_TEXT {
        return Err(anyhow!("native result exceeds limit"));
    }
    let result: TaskResult = serde_json::from_value(value.clone())?;
    result
        .valid()
        .then_some(result)
        .ok_or_else(|| anyhow!("invalid task result"))
}
fn result_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["status","summary","verification"],"properties":{"status":{"enum":["succeeded","failed","blocked"]},"summary":{"type":"string","maxLength":262144},"verification":{"type":"string","maxLength":262144},"files_changed":{"type":"array","items":{"type":"string"}},"files_deleted":{"type":"array","items":{"type":"string"}},"blockers":{"type":"array","items":{"type":"string"}},"approval_requests":{"type":"array"},"branch":{"type":"string"},"commit":{"type":"string"}}})
}
fn assistant_text(value: &Value) -> Option<&str> {
    value
        .pointer("/message/content")
        .and_then(Value::as_array)
        .and_then(|parts| {
            parts
                .iter()
                .find_map(|p| p.get("text").and_then(Value::as_str))
        })
        .or_else(|| value.pointer("/item/text").and_then(Value::as_str))
        .or_else(|| value.pointer("/item/content").and_then(Value::as_str))
        .or_else(|| value.get("text").and_then(Value::as_str))
}
fn session_from_state(value: Option<&Value>) -> (Option<String>, Option<String>) {
    (
        value
            .and_then(|v| v.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        value
            .and_then(|v| v.get("sessionFile"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}
async fn emit(events: &mpsc::Sender<WorkerEvent>, event: WorkerEvent) -> Result<()> {
    events
        .send(event)
        .await
        .map_err(|_| anyhow!("event receiver closed"))
}
async fn emit_session(
    events: &mpsc::Sender<WorkerEvent>,
    session: &(Option<String>, Option<String>),
) -> Result<()> {
    if let Some(session_id) = &session.0 {
        emit(
            events,
            WorkerEvent::Session {
                session_id: session_id.clone(),
                session_file: session.1.clone(),
            },
        )
        .await?;
    }
    Ok(())
}
fn ensure_session_id(spec: &TaskSpec, actual: &Option<String>) -> Result<()> {
    let actual = actual
        .as_deref()
        .ok_or_else(|| anyhow!("native session identity missing"))?;
    if let Some(expected) = &spec.session_id {
        if expected != actual {
            return Err(anyhow!("native session identity mismatch"));
        }
    }
    Ok(())
}
fn ensure_session_file(spec: &TaskSpec, actual: &Option<String>) -> Result<()> {
    if spec.harness == "omp" && actual.is_none() {
        return Err(anyhow!("OMP session file missing"));
    }
    if let Some(expected) = &spec.session_file {
        if actual.as_ref() != Some(expected) {
            return Err(anyhow!("native session file mismatch"));
        }
    }
    Ok(())
}
fn success(
    result: TaskResult,
    session_id: Option<String>,
    session_file: Option<String>,
    spec: &TaskSpec,
) -> WorkerOutcome {
    WorkerOutcome {
        status: result.status.clone(),
        result: Some(result),
        error: None,
        session_id,
        session_file,
        model: spec.model.clone(),
    }
}
fn failed(error: String, spec: &TaskSpec) -> WorkerOutcome {
    WorkerOutcome {
        status: "failed".into(),
        result: None,
        error: Some(error),
        session_id: spec.session_id.clone(),
        session_file: spec.session_file.clone(),
        model: spec.model.clone(),
    }
}
fn unknown(error: String, spec: &TaskSpec) -> WorkerOutcome {
    WorkerOutcome {
        status: "unknown".into(),
        result: None,
        error: Some(error),
        session_id: spec.session_id.clone(),
        session_file: spec.session_file.clone(),
        model: spec.model.clone(),
    }
}
async fn stop_and_reap(child: &mut Child, identity: &ProcessIdentity) -> bool {
    let _ = terminate(identity).await;
    let reaped = matches!(
        timeout(Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    );
    reaped && group_gone(identity).unwrap_or(false)
}
fn retain(target: &mut String, line: &str) {
    for character in line.chars() {
        if target.len() + character.len_utf8() > MAX_TEXT {
            break;
        }
        target.push(character);
    }
}
fn append_ui(spec: &TaskSpec, text: &str) {
    if text.is_empty() || text.len() > MAX_TEXT {
        return;
    }
    let record = json!({"version":1,"type":"ui","payload":{"text":text}}).to_string();
    let path = Path::new(&spec.log);
    if !path.parent().is_some_and(Path::is_dir) {
        return;
    }
    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.len().saturating_add(record.len() as u64 + 1) > LOG_LIMIT {
            let rotated = path.with_extension("1");
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(path, rotated);
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln::write_line(&mut file, &record);
    }
}
mod writeln {
    use std::io::Write;
    pub(super) fn write_line(file: &mut std::fs::File, line: &str) -> std::io::Result<()> {
        writeln!(file, "{line}")
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_frame, parse_result};

    #[test]
    fn rejects_bare_native_frames_and_untyped_results() {
        assert!(parse_frame("\"noise\"").is_err());
        assert!(parse_frame("{\"unexpected\":true}").is_err());
        assert!(parse_result(
            r#"{"status":"succeeded","summary":"ok","verification":"done","extra":true}"#
        )
        .is_err());
    }

    #[test]
    fn accepts_only_complete_typed_result() {
        assert!(
            parse_result(r#"{"status":"succeeded","summary":"ok","verification":"done"}"#).is_ok()
        );
    }
}
