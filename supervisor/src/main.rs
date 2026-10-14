mod process;
mod protocol;
mod store;
mod worker;

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use fs2::FileExt;
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{watch, Notify, Semaphore};

use protocol::{error, parse_command, response, TaskSpec, WorkerEvent};
use store::{Completion, Store, TaskSnapshot};

const MAX_CONNECTIONS: usize = 32;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long)]
        socket: PathBuf,
    },
    View {
        #[arg(long)]
        log: PathBuf,
        /// OMP session directory: show the live worker transcript instead of the UI log.
        #[arg(long)]
        session_dir: Option<PathBuf>,
    },
}
struct Daemon {
    store: Arc<Store>,
    active: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    slots: Arc<Semaphore>,
    stopping: watch::Sender<bool>,
    changed: Notify,
}

enum FrameError {
    Closed,
    TimedOut,
    TooLarge,
    Io,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Serve { state_dir, socket } => serve(state_dir, socket).await,
        Command::View {
            session_dir: Some(dir),
            ..
        } => view_session(dir),
        Command::View { log, .. } => view(log),
    }
}

async fn serve(state_dir: PathBuf, socket: PathBuf) -> Result<()> {
    fs::create_dir_all(&state_dir).context("creating state directory")?;
    fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700))?;
    let _lock = acquire_lock(&state_dir)?;
    if socket.exists() {
        fs::remove_file(&socket).context("removing stale socket")?;
    }
    let store = Arc::new(Store::open(&state_dir.join("supervisor.sqlite"))?);
    let listener = UnixListener::bind(&socket).context("binding supervisor socket")?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let (stopping, _) = watch::channel(false);
    let daemon = Arc::new(Daemon {
        store,
        active: Arc::new(Mutex::new(HashMap::new())),
        slots: Arc::new(Semaphore::new(4)),
        stopping: stopping.clone(),
        changed: Notify::new(),
    });
    start_scheduler(daemon.clone());
    println!(
        "{}",
        serde_json::to_string(&response(
            "00000000-0000-0000-0000-000000000000",
            json!({"ok":true,"ready":true})
        ))?
    );
    let admission = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut shutdown = stopping.subscribe();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let Ok(permit) = admission.clone().try_acquire_owned() else { drop(stream); continue };
                let daemon = daemon.clone();
                tokio::spawn(async move { let _permit = permit; let _ = handle_connection(stream, daemon).await; });
            }
            changed = shutdown.changed() => if changed.is_ok() && *shutdown.borrow() { break; },
            signal = tokio::signal::ctrl_c() => { signal?; let _ = stopping.send(true); break; },
            _ = term.recv() => { let _ = stopping.send(true); break; },
        }
    }
    cancel_all(&daemon);
    drain(&daemon).await;
    let _ = fs::remove_file(socket);
    Ok(())
}

fn acquire_lock(state_dir: &Path) -> Result<File> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(state_dir.join("supervisor.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| anyhow!("another supervisor owns this state directory"))?;
    Ok(lock)
}

fn start_scheduler(daemon: Arc<Daemon>) {
    tokio::spawn(async move {
        let mut stopping = daemon.stopping.subscribe();
        loop {
            tokio::select! { _ = stopping.changed() => break, _ = tokio::time::sleep(Duration::from_millis(50)) => {} }
            while let Ok(permit) = daemon.slots.clone().try_acquire_owned() {
                let Some(task) = daemon.store.next_queued().ok().flatten() else {
                    drop(permit);
                    break;
                };
                let Some(task) = daemon.store.mark_running(&task.request_id).ok().flatten() else {
                    drop(permit);
                    continue;
                };
                daemon.changed.notify_waiters();
                let (cancel, receiver) = watch::channel(false);
                if let Ok(mut active) = daemon.active.lock() {
                    active.insert(task.request_id.clone(), cancel);
                }
                let daemon = daemon.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    run_task(daemon, task, receiver).await;
                });
            }
        }
    });
}

async fn run_task(daemon: Arc<Daemon>, task: TaskSnapshot, receiver: watch::Receiver<bool>) {
    let request_id = task.request_id.clone();
    let (events, mut incoming) = tokio::sync::mpsc::channel(16);
    let execution = worker::execute(&request_id, &task.spec, receiver, events);
    tokio::pin!(execution);
    let outcome = loop {
        tokio::select! {
            outcome = &mut execution => break outcome,
            event = incoming.recv() => if let Some(event) = event { persist_event(&daemon, &request_id, event) },
        }
    };
    while let Ok(event) = incoming.try_recv() {
        persist_event(&daemon, &request_id, event);
    }
    let state = match outcome.status.as_str() {
        "succeeded" | "failed" | "blocked" => outcome.status.as_str(),
        _ => "unknown",
    };
    let completion = if outcome
        .result
        .as_ref()
        .is_some_and(|result| !result.valid())
    {
        Completion {
            state: "failed",
            result: None,
            error: Some("invalid_worker_result"),
            session_id: outcome.session_id.as_deref(),
            session_file: outcome.session_file.as_deref(),
            model: outcome.model.as_deref(),
        }
    } else {
        Completion {
            state,
            result: outcome.result.as_ref(),
            error: outcome.error.as_deref(),
            session_id: outcome.session_id.as_deref(),
            session_file: outcome.session_file.as_deref(),
            model: outcome.model.as_deref(),
        }
    };
    let completed = daemon.store.complete(&request_id, completion);
    if completed.is_err() {
        let _ = daemon.store.event(
            &request_id,
            "unknown",
            json!({"error":"terminal_commit_failed"}),
        );
    }
    daemon.changed.notify_waiters();
    if let Ok(mut active) = daemon.active.lock() {
        active.remove(&request_id);
    }
}

fn persist_event(daemon: &Daemon, request_id: &str, event: WorkerEvent) {
    let store = &daemon.store;
    match event {
        WorkerEvent::Started => {
            let _ = store.event(request_id, "started", json!({}));
        }
        WorkerEvent::Owned {
            pid,
            starttime,
            pgid,
        } => match process::capture(pid) {
            Ok(identity) if identity.starttime == starttime && identity.pgid == pgid => {
                let _ = store.owned(request_id, &identity);
            }
            _ => {
                let _ = store.event(
                    request_id,
                    "ownership_error",
                    json!({"error":"native_identity_mismatch"}),
                );
            }
        },
        WorkerEvent::Session {
            session_id,
            session_file,
        } => {
            let _ = store.session(request_id, &session_id, session_file.as_deref());
        }
    }
    daemon.changed.notify_waiters();
}

async fn handle_connection(mut stream: UnixStream, daemon: Arc<Daemon>) -> Result<()> {
    let credential = stream.peer_cred().context("reading peer credential")?;
    if credential.uid() != unsafe { libc::geteuid() } {
        return Ok(());
    }
    let reply = match read_frame(&mut stream).await {
        Ok(frame) => match parse_command(&frame) {
            Ok(command) => dispatch(&command.id, &command.kind, command.payload, &daemon).await,
            Err(code) => error(
                "00000000-0000-0000-0000-000000000000",
                code,
                "invalid supervisor command",
            ),
        },
        Err(FrameError::TooLarge) => error(
            "00000000-0000-0000-0000-000000000000",
            "frame_too_large",
            "supervisor frame exceeds 1MiB",
        ),
        Err(FrameError::TimedOut) => error(
            "00000000-0000-0000-0000-000000000000",
            "read_timeout",
            "supervisor read timed out",
        ),
        Err(FrameError::Closed) => error(
            "00000000-0000-0000-0000-000000000000",
            "read_closed",
            "peer closed before command",
        ),
        Err(FrameError::Io) => error(
            "00000000-0000-0000-0000-000000000000",
            "read_error",
            "supervisor read failed",
        ),
    };
    let bytes = serde_json::to_vec(&reply)?;
    if bytes.len() <= protocol::MAX_FRAME {
        stream.write_all(&bytes).await?;
        stream.write_all(b"\n").await?;
    }
    Ok(())
}

async fn read_frame(stream: &mut UnixStream) -> std::result::Result<Vec<u8>, FrameError> {
    let mut frame = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    loop {
        let count = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| FrameError::TimedOut)?
            .map_err(|_| FrameError::Io)?;
        if count == 0 {
            return Err(FrameError::Closed);
        }
        let bytes = &chunk[..count];
        let end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap_or(count);
        if frame.len() + end > protocol::MAX_FRAME {
            return Err(FrameError::TooLarge);
        }
        frame.extend_from_slice(&bytes[..end]);
        if end != count {
            return Ok(frame);
        }
    }
}

async fn dispatch(
    id: &str,
    command: &str,
    payload: Map<String, Value>,
    daemon: &Arc<Daemon>,
) -> Value {
    match command {
        "health" if payload.is_empty() => response(id, json!({"ok":true,"healthy":true})),
        "submit" => match serde_json::from_value::<TaskSpec>(Value::Object(payload)) {
            Ok(spec) if serde_json::to_vec(&spec).is_ok_and(|bytes| bytes.len() > 512 * 1024) => {
                error_response(id, "payload_too_large")
            }
            Ok(spec) if validate_spec(&spec).is_ok() => match daemon.store.submit(id, &spec) {
                Ok((task, _)) => response(
                    id,
                    json!({"ok":true,"request_id":task.request_id,"state":task.state,"task":task.spec.task,"worker":task.spec.worker}),
                ),
                Err(error)
                    if matches!(
                        error.to_string().as_str(),
                        "request_conflict" | "task_conflict"
                    ) =>
                {
                    error_response(id, "conflict")
                }
                Err(error) if error.to_string() == "queue_full" => error_response(id, "queue_full"),
                Err(_) => error_response(id, "storage_error"),
            },
            _ => error_response(id, "invalid_payload"),
        },
        "get" => match string_field(&payload, "request_id") {
            Some(request_id) if payload.len() == 1 => match daemon.store.get(request_id) {
                Ok(task) => {
                    bounded_response(id, json!({"ok":true,"task":task.map(snapshot_value)}))
                }
                Err(_) => error_response(id, "storage_error"),
            },
            _ => error_response(id, "invalid_payload"),
        },
        "wait" => wait_command(id, &payload, daemon).await,
        "ack" => match (
            string_field(&payload, "request_id"),
            integer_field(&payload, "seq"),
        ) {
            (Some(request_id), Some(seq)) if payload.len() == 2 => {
                match daemon.store.acknowledge(request_id, seq) {
                    Ok(()) => response(id, json!({"ok":true})),
                    Err(_) => error_response(id, "storage_error"),
                }
            }
            _ => error_response(id, "invalid_payload"),
        },
        "status" => status_command(id, &payload, daemon),
        "stop" => match (
            string_field(&payload, "team"),
            string_field(&payload, "worker"),
        ) {
            (Some(team), Some(worker)) if payload.len() == 2 => {
                match stop_worker(daemon, team, worker).await {
                    Ok(()) => response(id, json!({"ok":true,"stopped":true})),
                    Err(code) => error_response(id, code),
                }
            }
            _ => error_response(id, "invalid_payload"),
        },
        "shutdown" if payload.is_empty() => {
            let _ = daemon.stopping.send(true);
            cancel_all(daemon);
            response(id, json!({"ok":true}))
        }
        _ => error_response(id, "invalid_command"),
    }
}

fn status_command(id: &str, payload: &Map<String, Value>, daemon: &Arc<Daemon>) -> Value {
    let team = payload.get("team").and_then(Value::as_str);
    let after = payload
        .get("after")
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
        .unwrap_or(0);
    let limit = payload
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|value| (1..=128).contains(value))
        .map_or(64, |value| value as usize);
    if payload
        .keys()
        .any(|key| key != "team" && key != "after" && key != "limit")
        || payload.get("team").is_some_and(|value| !value.is_string())
    {
        return error_response(id, "invalid_payload");
    }
    match daemon.store.status(team, after, limit) {
        Ok((workers, next_after, has_more, queued)) => bounded_response(
            id,
            json!({"ok":true,"workers":workers,"queued":queued,"next_after":next_after,"has_more":has_more}),
        ),
        Err(_) => error_response(id, "storage_error"),
    }
}

async fn wait_command(id: &str, payload: &Map<String, Value>, daemon: &Arc<Daemon>) -> Value {
    let (Some(request_id), Some(after), Some(timeout)) = (
        string_field(payload, "request_id"),
        integer_field(payload, "after_seq"),
        integer_field(payload, "timeout_ms"),
    ) else {
        return error_response(id, "invalid_payload");
    };
    if payload.len() != 3 || timeout > 60_000 {
        return error_response(id, "invalid_payload");
    }
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout as u64);
    loop {
        let notified = daemon.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        match daemon.store.wait(request_id, after) {
            Ok((events, more, task)) if !events.is_empty() || more || is_terminal(&task.state) => {
                return wait_response(id, events, more, task);
            }
            Ok((events, more, task)) if timeout == 0 => {
                return wait_response(id, events, more, task);
            }
            Ok(_) => {
                tokio::select! {
                    _ = &mut notified => {}
                    _ = tokio::time::sleep_until(deadline) => {
                        return match daemon.store.wait(request_id, after) {
                            Ok((events, more, task)) => wait_response(id, events, more, task),
                            Err(error) if error.to_string() == "not_found" => error_response(id, "not_found"),
                            Err(_) => error_response(id, "storage_error"),
                        };
                    }
                }
            }
            Err(error) if error.to_string() == "not_found" => {
                return error_response(id, "not_found")
            }
            Err(_) => return error_response(id, "storage_error"),
        }
    }
}

fn wait_response(id: &str, events: Vec<Value>, more: bool, task: TaskSnapshot) -> Value {
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("events".into(), Value::Array(events));
    payload.insert("task".into(), snapshot_value(task));
    payload.insert("has_more".into(), Value::Bool(more));
    let mut value = response(id, Value::Object(payload));
    loop {
        if serde_json::to_vec(&value).is_ok_and(|bytes| bytes.len() <= protocol::MAX_FRAME) {
            return value;
        }
        let Some(events) = value
            .pointer_mut("/payload/events")
            .and_then(Value::as_array_mut)
        else {
            return error_response(id, "response_too_large");
        };
        if events.pop().is_none() {
            return error_response(id, "response_too_large");
        }
        value["payload"]["has_more"] = Value::Bool(true);
    }
}

fn bounded_response(id: &str, payload: Value) -> Value {
    let value = response(id, payload);
    if serde_json::to_vec(&value).is_ok_and(|bytes| bytes.len() <= protocol::MAX_FRAME) {
        value
    } else {
        error_response(id, "response_too_large")
    }
}

async fn stop_worker(
    daemon: &Daemon,
    team: &str,
    worker: &str,
) -> std::result::Result<(), &'static str> {
    daemon
        .store
        .stop_queued(team, worker)
        .map_err(|_| "storage_error")?;
    daemon.changed.notify_waiters();
    let senders = daemon
        .active
        .lock()
        .ok()
        .map(|active| {
            active
                .iter()
                .filter_map(|(request_id, sender)| {
                    daemon
                        .store
                        .get(request_id)
                        .ok()
                        .flatten()
                        .filter(|task| task.spec.team == team && task.spec.worker == worker)
                        .map(|_| sender.clone())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sender in senders {
        let _ = sender.send(true);
    }
    let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
    loop {
        let owned = daemon
            .store
            .owned_for(team, worker)
            .map_err(|_| "storage_error")?;
        if owned.is_empty() {
            return Ok(());
        }
        for task in &owned {
            if daemon
                .active
                .lock()
                .is_ok_and(|active| active.contains_key(&task.request_id))
            {
                continue;
            }
            let Some(identity) = &task.identity else {
                return Err("stop_not_proven");
            };
            let _ = process::terminate(identity)
                .await
                .map_err(|_| "stop_not_proven")?;
            if process::group_gone(identity).map_err(|_| "stop_not_proven")? {
                let unknown = daemon
                    .store
                    .get(&task.request_id)
                    .map_err(|_| "storage_error")?
                    .is_some_and(|snapshot| snapshot.state == "unknown");
                if unknown {
                    daemon
                        .store
                        .release_unknown_fence(&task.request_id)
                        .map_err(|_| "storage_error")?;
                } else {
                    daemon
                        .store
                        .mark_stopped(&task.request_id)
                        .map_err(|_| "storage_error")?;
                }
                daemon.changed.notify_waiters();
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("stop_not_proven");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn drain(daemon: &Daemon) {
    let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
    loop {
        if daemon.active.lock().is_ok_and(|active| active.is_empty())
            || tokio::time::Instant::now() >= deadline
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn validate_spec(spec: &TaskSpec) -> Result<(), &'static str> {
    if spec.team.is_empty()
        || spec.worker.is_empty()
        || spec.task.is_empty()
        || spec.prompt.len() > protocol::MAX_TEXT
        || !matches!(spec.harness.as_str(), "omp" | "claude" | "codex")
        || spec.argv.is_empty()
        || spec.max_timeout_ms == 0
    {
        Err("invalid")
    } else {
        Ok(())
    }
}
fn snapshot_value(task: TaskSnapshot) -> Value {
    json!({"request_id":task.request_id,"spec":task.spec,"state":task.state,"result":task.result,"error":task.error,"session_id":task.session_id,"session_file":task.session_file,"model":task.model,"created_ms":task.created_ms,"updated_ms":task.updated_ms})
}
fn string_field<'a>(payload: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    payload.get(name).and_then(Value::as_str)
}
fn integer_field(payload: &Map<String, Value>, name: &str) -> Option<i64> {
    payload
        .get(name)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 0)
}
fn is_terminal(state: &str) -> bool {
    matches!(state, "succeeded" | "failed" | "blocked" | "unknown")
}
fn error_response(id: &str, code: &str) -> Value {
    error(id, code, "supervisor command failed")
}
fn cancel_all(daemon: &Daemon) {
    if let Ok(active) = daemon.active.lock() {
        for sender in active.values() {
            let _ = sender.send(true);
        }
    }
}

fn view(log: PathBuf) -> Result<()> {
    let mut offset = 0;
    let mut inode = None;
    let mut discarding = false;
    loop {
        match File::open(&log) {
            Ok(file) => {
                let metadata = file.metadata()?;
                let current_inode = (metadata.dev(), metadata.ino());
                if inode != Some(current_inode) || metadata.len() < offset {
                    offset = 0;
                    discarding = false;
                    inode = Some(current_inode);
                }
                let mut reader = BufReader::with_capacity(8192, file);
                reader.seek(SeekFrom::Start(offset))?;
                let mut line = Vec::with_capacity(1024);
                loop {
                    line.clear();
                    let read = Read::by_ref(&mut reader)
                        .take(protocol::MAX_FRAME as u64 + 1)
                        .read_until(b'\n', &mut line)?;
                    if read == 0 {
                        break;
                    }
                    let complete = line.last() == Some(&b'\n');
                    if discarding || line.len() > protocol::MAX_FRAME {
                        offset += read as u64;
                        discarding = !complete;
                        continue;
                    }
                    if !complete {
                        break;
                    }
                    offset += read as u64;
                    line.pop();
                    print_ui(&line);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// Redraws the newest OMP session transcript through `omp render` whenever it grows or the pane resizes.
// ponytail: full re-render per change; switch to incremental rendering if long sessions repaint slowly.
fn view_session(dir: PathBuf) -> Result<()> {
    let mut stdout = std::io::stdout();
    writeln!(stdout, "waiting for the first assignment")?;
    stdout.flush()?;
    let mut shown = None;
    loop {
        let newest = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                Some((metadata.modified().ok()?, metadata.len(), entry.path()))
            })
            .max();
        if let Some((_, len, path)) = newest {
            let width = terminal_width();
            let key = Some((path.clone(), len, width));
            if key != shown {
                let rendered = std::process::Command::new("omp")
                    .arg("render")
                    .arg(&path)
                    .arg("--width")
                    .arg(width.to_string())
                    .stdin(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .output();
                // A failed render (e.g. a half-written line) retries on the next tick.
                if let Ok(rendered) = rendered {
                    if rendered.status.success() {
                        stdout.write_all(b"\x1b[H\x1b[2J\x1b[3J")?;
                        stdout.write_all(&rendered.stdout)?;
                        stdout.flush()?;
                        shown = key;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn terminal_width() -> u16 {
    // SAFETY: TIOCGWINSZ only writes into the zeroed winsize we pass.
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } == 0;
    if ok && size.ws_col > 0 {
        size.ws_col
    } else {
        120
    }
}

fn print_ui(record: &[u8]) {
    let Ok(value) = serde_json::from_slice::<Value>(record) else {
        return;
    };
    let Some(text) = value
        .as_object()
        .filter(|object| {
            object.get("version") == Some(&json!(1))
                && object.get("type").and_then(Value::as_str) == Some("ui")
        })
        .and_then(|object| object.get("payload"))
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("text"))
        .and_then(Value::as_str)
    else {
        return;
    };
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    for character in text.chars() {
        if character.is_control() {
            let _ = write!(output, "\\u{{{:04x}}}", character as u32);
        } else {
            let _ = write!(output, "{character}");
        }
    }
    let _ = writeln!(output);
}
