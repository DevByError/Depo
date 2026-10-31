//! Engine sidecar lifecycle: spawn, handshake, restart with backoff, shutdown.
//!
//! The engine prints exactly one line on stdout when ready:
//! `DEPO_ENGINE_READY {"port":1234,"pid":42,"version":"0.1.0"}`.
//! The shell keeps the per-launch token and the port, and hands both to the UI via
//! the `engine_connection` command. The token never leaves this process otherwise.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const READY_PREFIX: &str = "DEPO_ENGINE_READY ";
const MAX_RESTARTS_PER_WINDOW: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct EngineReady {
    pub port: u16,
    pub pid: u32,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineConnection {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineExit {
    pub code: Option<i32>,
    pub will_restart: bool,
    pub message: String,
}

pub struct EngineState {
    token: String,
    ready: Mutex<Option<EngineReady>>,
    child: Mutex<Option<CommandChild>>,
    restarts: Mutex<Vec<Instant>>,
    quitting: Mutex<bool>,
    last_error: Mutex<Option<String>>,
}

impl EngineState {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            token: new_token()?,
            ready: Mutex::new(None),
            child: Mutex::new(None),
            restarts: Mutex::new(Vec::new()),
            quitting: Mutex::new(false),
            last_error: Mutex::new(None),
        })
    }

    pub fn connection(&self) -> Option<EngineConnection> {
        let ready = self.ready.lock().ok()?;
        ready.as_ref().map(|r| EngineConnection { port: r.port, token: self.token.clone() })
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    pub fn set_error(&self, message: String) {
        if let Ok(mut e) = self.last_error.lock() {
            *e = Some(message);
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut q) = self.quitting.lock() {
            *q = true;
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(c) = child.take() {
                let _ = c.kill();
            }
        }
    }

    fn is_quitting(&self) -> bool {
        self.quitting.lock().map(|q| *q).unwrap_or(true)
    }

    /// Records a restart; returns false when too many restarts happened recently.
    fn allow_restart(&self, now: Instant) -> bool {
        let Ok(mut r) = self.restarts.lock() else { return false };
        r.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        if r.len() >= MAX_RESTARTS_PER_WINDOW {
            return false;
        }
        r.push(now);
        true
    }
}

/// 32 random bytes as 64 hex characters.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("could not generate engine token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Parses one stdout line; returns the handshake if the line is the ready line.
pub fn parse_ready_line(line: &str) -> Option<EngineReady> {
    let rest = line.trim_end_matches(['\r', '\n']).strip_prefix(READY_PREFIX)?;
    let ready: EngineReady = serde_json::from_str(rest).ok()?;
    if ready.port == 0 {
        return None;
    }
    Some(ready)
}

pub fn spawn<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<EngineState>();
    if let Ok(mut r) = state.ready.lock() {
        *r = None;
    }

    let data_dir_override = std::env::var("DEPO_DATA_DIR").ok();
    let mut cmd = app
        .shell()
        .sidecar("depo-engine")
        .map_err(|e| format!("engine sidecar not found: {e}"))?
        .env("DEPO_ENGINE_TOKEN", &state.token)
        .env("DEPO_ENGINE_PORT", "0")
        .env("DEPO_PARENT_PID", std::process::id().to_string())
        .env("DEPO_EXIT_ON_STDIN_CLOSE", "1");
    if let Some(dir) = data_dir_override {
        cmd = cmd.env("DEPO_DATA_DIR", dir);
    }

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("could not start the engine: {e}"))?;
    if let Ok(mut c) = state.child.lock() {
        *c = Some(child);
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(idx) = buf.find('\n') {
                        let line: String = buf.drain(..=idx).collect();
                        if let Some(ready) = parse_ready_line(&line) {
                            log::info!("engine ready on port {} (pid {})", ready.port, ready.pid);
                            let st = app.state::<EngineState>();
                            if let Ok(mut r) = st.ready.lock() {
                                *r = Some(ready.clone());
                            }
                            if let Ok(mut e) = st.last_error.lock() {
                                *e = None;
                            }
                            let _ = app.emit("engine://ready", ready.port);
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    log::debug!("engine: {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Error(err) => {
                    log::error!("engine error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    on_terminated(&app, payload.code);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn on_terminated<R: Runtime>(app: &AppHandle<R>, code: Option<i32>) {
    let state = app.state::<EngineState>();
    if let Ok(mut r) = state.ready.lock() {
        *r = None;
    }
    if let Ok(mut c) = state.child.lock() {
        *c = None;
    }
    if state.is_quitting() {
        return;
    }
    let will_restart = state.allow_restart(Instant::now());
    let message = if will_restart {
        format!("The engine stopped (code {code:?}). Restarting…")
    } else {
        "The engine keeps stopping. See the logs in %LOCALAPPDATA%\\Depo\\logs.".to_string()
    };
    log::warn!("{message}");
    if let Ok(mut e) = state.last_error.lock() {
        *e = Some(message.clone());
    }
    let _ = app.emit("engine://exited", EngineExit { code, will_restart, message });
    if will_restart {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Err(e) = spawn(&app) {
                log::error!("engine restart failed: {e}");
                app.state::<EngineState>().set_error(e);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_line() {
        let r = parse_ready_line("DEPO_ENGINE_READY {\"port\":51234,\"pid\":99,\"version\":\"0.1.0\"}\r\n").unwrap();
        assert_eq!(r, EngineReady { port: 51234, pid: 99, version: "0.1.0".into() });
    }

    #[test]
    fn ignores_other_lines() {
        assert!(parse_ready_line("hello").is_none());
        assert!(parse_ready_line("DEPO_ENGINE_READY not-json").is_none());
        assert!(parse_ready_line("DEPO_ENGINE_READY {\"port\":0,\"pid\":1,\"version\":\"x\"}").is_none());
        assert!(parse_ready_line(" DEPO_ENGINE_READY {\"port\":1,\"pid\":1,\"version\":\"x\"}").is_none());
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn restart_budget_is_limited() {
        let s = EngineState::new().unwrap();
        let now = Instant::now();
        for _ in 0..MAX_RESTARTS_PER_WINDOW {
            assert!(s.allow_restart(now));
        }
        assert!(!s.allow_restart(now));
        assert!(s.allow_restart(now + RESTART_WINDOW + Duration::from_secs(1)));
    }
}
