#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod config;
mod integration;
mod pty;
mod sys;
mod tools;

use ai::{AiRequest, AiState};
use pty::Sessions;
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Command;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
fn pty_spawn(app: AppHandle, sessions: State<Sessions>, id: u32, cols: u16, rows: u16, cwd: Option<String>) -> Result<(), String> {
    let cfg = config::load();
    let shell = cfg["shell"].as_str().map(String::from);
    let integrate = cfg["shellIntegration"].as_bool().unwrap_or(true);
    let (a, b) = (app.clone(), app);
    let s = sessions.inner().clone();
    sessions.spawn(
        id,
        cols,
        rows,
        cwd,
        shell,
        integrate,
        move |data| { let _ = a.emit("pty-data", json!({ "id": id, "data": data })); },
        move || { s.kill(id); let _ = b.emit("pty-exit", json!({ "id": id })); },
    )
}

#[tauri::command]
fn pty_write(sessions: State<Sessions>, id: u32, data: String) -> Result<(), String> {
    sessions.write(id, &data)
}

#[tauri::command]
fn pty_resize(sessions: State<Sessions>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    sessions.resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(sessions: State<Sessions>, id: u32) {
    sessions.kill(id)
}

#[tauri::command]
fn pty_fg(sessions: State<Sessions>, id: u32) -> Option<String> {
    sessions.fg(id)
}

#[tauri::command]
fn pty_cwd(sessions: State<Sessions>, id: u32) -> Option<String> {
    sessions.cwd(id)
}

#[derive(Serialize)]
struct GitInfo {
    branch: String,
    dirty: bool,
}

#[tauri::command(async)]
fn git_info(cwd: String) -> Option<GitInfo> {
    let out = Command::new("git").args(["-C", &cwd, "rev-parse", "--abbrev-ref", "HEAD"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let dirty = Command::new("git")
        .args(["-C", &cwd, "status", "--porcelain"])
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    Some(GitInfo { branch, dirty })
}

/// Indica cuáles de los ejecutables están en el PATH.
#[tauri::command(async)]
fn which_cmds(names: Vec<String>) -> Vec<bool> {
    use std::os::unix::fs::PermissionsExt;
    let dirs: Vec<_> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    names
        .iter()
        .map(|n| {
            dirs.iter().any(|d| {
                std::fs::metadata(d.join(n)).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
            })
        })
        .collect()
}

#[tauri::command(async)]
fn git_status(cwd: String) -> Option<Value> {
    let st = Command::new("git").args(["-C", &cwd, "status", "--porcelain=v1", "-b"]).output().ok()?;
    if !st.status.success() {
        return None;
    }
    let log = Command::new("git")
        .args(["-C", &cwd, "log", "-n", "8", "--pretty=format:%h%x09%s%x09%cr"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    Some(sys::parse_git(&String::from_utf8_lossy(&st.stdout), &log))
}

#[tauri::command(async)]
fn sys_stats() -> sys::SysStats {
    sys::stats()
}

#[tauri::command(async)]
fn disks_list() -> Vec<Value> {
    Command::new("df")
        .args(["-kP", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "efivarfs", "-x", "overlay"])
        .output()
        .map(|o| sys::parse_df(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[derive(serde::Deserialize)]
struct HttpReq {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: String,
}

/// Cliente HTTP del panel «API»: hace la petición que escribe el usuario y devuelve estado, cabeceras y cuerpo.
#[tauri::command]
async fn http_request(req: HttpReq) -> Result<Value, String> {
    const MAX: usize = 1024 * 1024;
    if !(req.url.starts_with("http://") || req.url.starts_with("https://")) {
        return Err("La URL debe empezar por http:// o https://".into());
    }
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|_| "Método HTTP no válido".to_string())?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let mut rb = client.request(method, &req.url);
    for (k, v) in req.headers {
        rb = rb.header(k, v);
    }
    if !req.body.is_empty() {
        rb = rb.body(req.body);
    }
    let t0 = std::time::Instant::now();
    let resp = rb.send().await.map_err(|e| format!("No se pudo completar la petición: {e}"))?;
    let status = resp.status();
    let headers: Vec<(String, String)> = resp.headers().iter().map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let ms = t0.elapsed().as_millis() as u64;
    Ok(json!({
        "status": status.as_u16(), "statusText": status.canonical_reason().unwrap_or(""), "timeMs": ms,
        "size": bytes.len(), "headers": headers, "truncated": bytes.len() > MAX,
        "body": String::from_utf8_lossy(&bytes[..bytes.len().min(MAX)]),
    }))
}

#[tauri::command(async)]
fn docker_ps() -> Result<Vec<Value>, String> {
    let out = Command::new("docker")
        .args(["ps", "-a", "--format", "{{json .}}"])
        .output()
        .map_err(|_| "Docker no está instalado o no está en el PATH".to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

#[tauri::command(async)]
fn docker_action(action: String, name: String) -> Result<(), String> {
    if !["start", "stop", "restart"].contains(&action.as_str()) {
        return Err("acción no permitida".into());
    }
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
        return Err("nombre de contenedor no válido".into());
    }
    let out = Command::new("docker").args([action.as_str(), name.as_str()]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect()) }
}

#[tauri::command(async)]
fn history_list(limit: Option<usize>) -> Vec<String> {
    tools::history(limit.unwrap_or(2000))
}

#[tauri::command(async)]
fn ps_list() -> Vec<Value> {
    Command::new("ps")
        .args(["-eo", "pid=,user=,pcpu=,pmem=,etime=,comm=,args=", "--sort=-pcpu"])
        .output()
        .map(|o| tools::parse_ps(&String::from_utf8_lossy(&o.stdout)).into_iter().take(500).collect())
        .unwrap_or_default()
}

#[tauri::command(async)]
fn ports_list() -> Result<Vec<Value>, String> {
    let out = Command::new("ss")
        .args(["-H", "-tulpn"])
        .output()
        .map_err(|_| "Falta el comando `ss` (paquete iproute2)".to_string())?;
    Ok(tools::parse_ports(&String::from_utf8_lossy(&out.stdout)))
}

#[tauri::command(async)]
fn proc_kill(pid: u32, signal: String) -> Result<(), String> {
    if pid <= 1 || !["TERM", "KILL", "INT", "HUP", "STOP", "CONT"].contains(&signal.as_str()) {
        return Err("señal o proceso no permitido".into());
    }
    let out = Command::new("kill").args([format!("-{signal}"), pid.to_string()]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

#[tauri::command(async)]
fn project_tasks(cwd: String) -> Value {
    tools::project_tasks(&cwd)
}

#[tauri::command(async)]
fn list_dir(path: String, hidden: Option<bool>) -> Result<Value, String> {
    tools::list_dir(&path, hidden.unwrap_or(false))
}

#[tauri::command(async)]
fn ssh_hosts() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    std::fs::read_to_string(format!("{home}/.ssh/config")).map(|c| sys::parse_ssh_hosts(&c)).unwrap_or_default()
}

#[tauri::command]
fn launch_args() -> sys::LaunchArgs {
    sys::parse_args(&std::env::args().skip(1).collect::<Vec<_>>())
}

/// Guarda texto en un archivo temporal (para abrir el historial en un pager o exportarlo).
#[tauri::command(async)]
fn write_temp(name: String, text: String) -> Result<String, String> {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    let dir = std::env::temp_dir().join("vexor");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(clean);
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn notify(title: String, body: String) {
    if let Ok(mut c) = Command::new("notify-send").args(["-a", "Vexor", &title, &body]).spawn() {
        std::thread::spawn(move || { let _ = c.wait(); });
    }
}

#[tauri::command]
fn new_window(cwd: Option<String>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("--no-restore");
    if let Some(d) = cwd {
        cmd.args(["--working-directory", &d]);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("solo se permiten enlaces http(s)".into());
    }
    let mut child = Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[tauri::command]
fn config_get() -> Value {
    config::public()
}

#[tauri::command]
fn config_set(patch: Value) -> Result<(), String> {
    config::set(patch)
}

#[tauri::command]
fn ai_chat(app: AppHandle, state: State<AiState>, id: u32, req: AiRequest) {
    let cfg = config::load()["ai"].clone();
    let st = state.inner().clone();
    tauri::async_runtime::spawn(ai::run(app, id, cfg, req, st));
}

#[tauri::command]
fn ai_cancel(state: State<AiState>, id: u32) {
    state.0.lock().unwrap().insert(u32::MAX - id);
}

fn main() {
    tauri::Builder::default()
        .manage(Sessions::default())
        .manage(AiState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill, pty_cwd, pty_fg, ssh_hosts, disks_list, http_request, history_list, ps_list, ports_list, proc_kill, project_tasks, list_dir, launch_args, write_temp, notify, new_window, git_info, git_status, sys_stats, docker_ps, docker_action, open_url,
            which_cmds, config_get, config_set, ai_chat, ai_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Vexor");
}
