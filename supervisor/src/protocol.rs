use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

pub(crate) const VERSION: u8 = 1;
pub(crate) const MAX_FRAME: usize = 1024 * 1024;
pub(crate) const MAX_TEXT: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskSpec {
    pub(crate) team_dir: String,
    pub(crate) team: String,
    pub(crate) worker: String,
    pub(crate) task: String,
    pub(crate) kind: String,
    pub(crate) cwd: String,
    pub(crate) harness: String,
    pub(crate) argv: Vec<String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) prompt: String,
    pub(crate) model: Option<String>,
    pub(crate) thinking: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) session_file: Option<String>,
    pub(crate) log: String,
    pub(crate) idle_timeout_ms: u64,
    pub(crate) max_timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskResult {
    pub(crate) status: String,
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) files_changed: Vec<String>,
    #[serde(default)]
    pub(crate) files_deleted: Vec<String>,
    pub(crate) verification: String,
    #[serde(default)]
    pub(crate) blockers: Vec<String>,
    #[serde(default)]
    pub(crate) approval_requests: Vec<Value>,
    #[serde(default)]
    pub(crate) branch: String,
    #[serde(default)]
    pub(crate) commit: String,
}

impl TaskResult {
    pub(crate) fn valid(&self) -> bool {
        matches!(self.status.as_str(), "succeeded" | "failed" | "blocked")
            && self.summary.len() <= MAX_TEXT
            && self.verification.len() <= MAX_TEXT
            && serde_json::to_vec(self).is_ok_and(|bytes| bytes.len() <= MAX_TEXT)
    }
}

#[derive(Clone, Debug)]
pub(crate) enum WorkerEvent {
    Started,
    Owned {
        pid: u32,
        starttime: u64,
        pgid: i32,
    },
    Session {
        session_id: String,
        session_file: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct WorkerOutcome {
    pub(crate) status: String,
    pub(crate) result: Option<TaskResult>,
    pub(crate) error: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) session_file: Option<String>,
    pub(crate) model: Option<String>,
}

#[derive(Debug)]
pub(crate) struct Command {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) payload: Map<String, Value>,
}

pub(crate) fn parse_command(frame: &[u8]) -> Result<Command, &'static str> {
    if frame.len() > MAX_FRAME {
        return Err("frame_too_large");
    }
    let value: Value = serde_json::from_slice(frame).map_err(|_| "malformed_json")?;
    let object = value.as_object().ok_or("invalid_envelope")?;
    if object.len() != 4
        || object.get("version") != Some(&json!(VERSION))
        || object.get("type").and_then(Value::as_str).is_none()
    {
        return Err("invalid_envelope");
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or("invalid_envelope")?;
    Uuid::parse_str(id).map_err(|_| "invalid_envelope")?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("invalid_envelope")?;
    if !matches!(
        kind,
        "health" | "submit" | "get" | "wait" | "ack" | "status" | "stop" | "shutdown"
    ) {
        return Err("invalid_command");
    }
    let (id, kind) = (id.to_owned(), kind.to_owned());
    let Value::Object(mut object) = value else {
        return Err("invalid_envelope");
    };
    let Value::Object(payload) = object.remove("payload").ok_or("invalid_envelope")? else {
        return Err("invalid_envelope");
    };
    Ok(Command { id, kind, payload })
}

pub(crate) fn response(id: &str, payload: Value) -> Value {
    Value::Object(Map::from_iter([
        ("version".into(), Value::from(VERSION)),
        ("id".into(), Value::String(id.to_owned())),
        ("type".into(), Value::String("response".into())),
        ("payload".into(), payload),
    ]))
}

pub(crate) fn error(id: &str, code: &str, message: &str) -> Value {
    response(
        id,
        json!({"ok": false, "error": {"code": code, "message": message}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_versioned_object_envelope() {
        let id = "00000000-0000-4000-8000-000000000001";
        let frame = format!(r#"{{"version":1,"id":"{id}","type":"health","payload":{{}}}}"#);
        assert_eq!(parse_command(frame.as_bytes()).unwrap().kind, "health");
        assert!(matches!(parse_command(b"null"), Err("invalid_envelope")));
        assert!(matches!(parse_command(b"[]"), Err("invalid_envelope")));
        assert!(matches!(parse_command(b"{"), Err("malformed_json")));
    }

    #[test]
    fn rejects_wrong_envelope_shape() {
        let frame = br#"{"version":1,"id":"00000000-0000-4000-8000-000000000001","type":"command","payload":{},"extra":true}"#;
        assert!(matches!(parse_command(frame), Err("invalid_envelope")));
    }
}
