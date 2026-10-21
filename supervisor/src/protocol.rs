use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

pub(crate) const VERSION: u8 = 1;
pub(crate) const MAX_TOOL_SESSIONS: usize = 32;
pub(crate) const MAX_TOOL_SESSION_ID: usize = 256;
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
pub(crate) struct ToolSession {
    pub(crate) kind: String,
    pub(crate) id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct TaskResult {
    pub(crate) status: String,
    pub(crate) summary: String,
    #[serde(default, deserialize_with = "result_strings")]
    pub(crate) files_changed: Vec<String>,
    #[serde(default, deserialize_with = "result_strings")]
    pub(crate) files_deleted: Vec<String>,
    #[serde(default, deserialize_with = "result_string")]
    pub(crate) verification: String,
    #[serde(default, deserialize_with = "result_strings")]
    pub(crate) blockers: Vec<String>,
    #[serde(default)]
    pub(crate) approval_requests: Vec<Value>,
    #[serde(default)]
    pub(crate) tool_sessions: Vec<ToolSession>,
    #[serde(default, deserialize_with = "result_string")]
    pub(crate) branch: String,
    #[serde(default, deserialize_with = "result_string")]
    pub(crate) commit: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ResultText {
    String(String),
    Strings(Vec<String>),
}

fn result_string<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(match Option::<ResultText>::deserialize(deserializer)? {
        Some(ResultText::String(text)) => text,
        Some(ResultText::Strings(lines)) => lines.join("\n"),
        None => String::new(),
    })
}

fn result_strings<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    Ok(match Option::<ResultText>::deserialize(deserializer)? {
        Some(ResultText::String(text)) => vec![text],
        Some(ResultText::Strings(lines)) => lines,
        None => Vec::new(),
    })
}

impl TaskResult {
    pub(crate) fn valid(&self) -> bool {
        matches!(self.status.as_str(), "succeeded" | "failed" | "blocked")
            && self.summary.len() <= MAX_TEXT
            && self.verification.len() <= MAX_TEXT
            && self.tool_sessions.len() <= MAX_TOOL_SESSIONS
            && self.tool_sessions.iter().all(|session| {
                session.kind == "tab"
                    && !session.id.is_empty()
                    && session.id.len() <= MAX_TOOL_SESSION_ID
                    && session
                        .id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
            })
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
    #[test]
    fn task_results_accept_only_bounded_tab_handles() {
        let parse = |tool_sessions| {
            serde_json::from_value::<TaskResult>(json!({
                "status": "succeeded",
                "summary": "ok",
                "verification": "done",
                "tool_sessions": tool_sessions,
            }))
            .unwrap()
        };
        let legacy = serde_json::from_value::<TaskResult>(json!({
            "status": "succeeded",
            "summary": "ok",
            "verification": "done",
        }))
        .unwrap();
        assert!(legacy.valid());
        assert!(parse(json!([])).valid());
        assert!(parse(json!([{"kind":"tab","id":"term_123"}])).valid());
        assert!(!parse(json!([{"kind":"claude","id":"session_123"}])).valid());
        assert!(!parse(json!([{"kind":"tab","id":"bad/id"}])).valid());
        assert!(!parse(json!([{"kind":"tab","id":""}])).valid());
        assert!(!parse(json!(vec![
            json!({"kind":"tab","id":"term_123"});
            MAX_TOOL_SESSIONS + 1
        ]))
        .valid());
    }
}
