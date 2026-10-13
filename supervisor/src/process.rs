use std::{fs, io, time::Duration};

use anyhow::{anyhow, Result};

#[derive(Clone, Debug)]
pub(crate) struct ProcessIdentity {
    pub(crate) pid: u32,
    pub(crate) starttime: u64,
    pub(crate) pgid: i32,
    pub(crate) boot_id: String,
}

pub(crate) fn capture(pid: u32) -> Result<ProcessIdentity> {
    if pid == 0 {
        return Err(anyhow!("native PID unavailable"));
    }
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (_, _, _, starttime) = stat_fields(&stat)?;
    // SAFETY: getpgid takes a scalar PID and does not dereference caller memory.
    let pgid = unsafe { libc::getpgid(pid as i32) };
    if pgid <= 0 {
        return Err(io::Error::last_os_error().into());
    }
    let boot_id = boot_id()?;
    Ok(ProcessIdentity {
        pid,
        starttime,
        pgid,
        boot_id,
    })
}

pub(crate) async fn terminate(identity: &ProcessIdentity) -> Result<bool> {
    let Some(current) = current_if_owned(identity) else {
        return group_gone(identity);
    };
    signal_group(current.pgid, libc::SIGTERM)?;
    if wait_group_gone(identity, Duration::from_secs(2)).await? {
        return Ok(true);
    }
    // Once the leader identity changes, a reused process group must never be killed.
    if current_if_owned(identity).is_none() {
        return Ok(false);
    }
    signal_group(identity.pgid, libc::SIGKILL)?;
    wait_group_gone(identity, Duration::from_secs(2)).await
}

pub(crate) fn group_gone(identity: &ProcessIdentity) -> Result<bool> {
    if boot_id()? != identity.boot_id {
        return Ok(true);
    }
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(_) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Ok((_, state, pgid, _)) = stat_fields(&stat) else {
            continue;
        };
        if pgid == identity.pgid && !matches!(state, 'Z' | 'X') {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn wait_group_gone(identity: &ProcessIdentity, duration: Duration) -> Result<bool> {
    let deadline = tokio::time::Instant::now() + duration;
    loop {
        if group_gone(identity)? {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn current_if_owned(identity: &ProcessIdentity) -> Option<ProcessIdentity> {
    capture(identity.pid)
        .ok()
        .filter(|current| same_process(current, identity))
}

fn signal_group(pgid: i32, signal: i32) -> Result<()> {
    // SAFETY: callers revalidate the saved PID, start time, PGID, and boot ID before signaling.
    unsafe {
        if libc::kill(-pgid, signal) == -1
            && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err(io::Error::last_os_error().into());
        }
    }
    Ok(())
}

fn stat_fields(stat: &str) -> Result<(u32, char, i32, u64)> {
    let (pid, rest) = stat
        .split_once(' ')
        .ok_or_else(|| anyhow!("invalid native proc stat"))?;
    let fields = rest
        .rsplit_once(") ")
        .ok_or_else(|| anyhow!("invalid native proc stat"))?
        .1;
    let mut fields = fields.split_whitespace();
    let state = fields
        .next()
        .and_then(|field| field.chars().next())
        .ok_or_else(|| anyhow!("native proc state missing"))?;
    let _ppid = fields.next();
    let pgid = fields
        .next()
        .ok_or_else(|| anyhow!("native proc group missing"))?
        .parse()?;
    let starttime = fields
        .nth(16)
        .ok_or_else(|| anyhow!("native proc starttime missing"))?
        .parse()?;
    Ok((pid.parse()?, state, pgid, starttime))
}

fn boot_id() -> Result<String> {
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?
        .trim()
        .to_owned();
    if boot_id.is_empty() {
        Err(anyhow!("system boot identity missing"))
    } else {
        Ok(boot_id)
    }
}

fn same_process(left: &ProcessIdentity, right: &ProcessIdentity) -> bool {
    left.pid == right.pid
        && left.starttime == right.starttime
        && left.pgid == right.pgid
        && left.boot_id == right.boot_id
}

#[cfg(test)]
mod tests {
    use super::stat_fields;

    #[test]
    fn parses_proc_stat_with_spaces_in_name() {
        let (_, state, pgid, starttime) =
            stat_fields("42 (native worker) S 1 42 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 99").unwrap();
        assert_eq!((state, pgid, starttime), ('S', 42, 99));
    }
}
