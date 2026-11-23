//! Gestión de PTYs (independiente de Tauri: recibe callbacks para emitir salida).
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};

pub struct Session {
    pid: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default, Clone)]
pub struct Sessions(Arc<Mutex<HashMap<u32, Session>>>);

/// Si el entorno no tiene un locale UTF-8, bash/readline descarta los caracteres no ASCII que se teclean
/// (ñ, tildes, ü…). Devuelve las variables a añadir para evitarlo.
pub fn utf8_env(get: &dyn Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let non_empty = |k: &str| get(k).filter(|v| !v.is_empty());
    let effective = non_empty("LC_ALL").or_else(|| non_empty("LC_CTYPE")).or_else(|| non_empty("LANG")).unwrap_or_default().to_lowercase();
    if effective.contains("utf-8") || effective.contains("utf8") {
        return vec![];
    }
    let key = if non_empty("LC_ALL").is_some() { "LC_ALL" } else { "LC_CTYPE" };
    vec![(key.to_string(), "C.UTF-8".to_string())]
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

impl Sessions {
    /// Lanza el shell del usuario en un PTY. `on_data` recibe texto UTF-8 válido;
    /// `on_exit` se llama una vez cuando el proceso termina.
    pub fn spawn(
        &self,
        id: u32,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        integrate: bool,
        on_data: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
        let shell = shell
            .filter(|s| !s.trim().is_empty())
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/bash".into());
        let (args, envs) = if integrate { crate::integration::setup(&shell) } else { (vec![], vec![]) };
        let mut cmd = CommandBuilder::new(shell);
        cmd.args(args);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        for (k, v) in utf8_env(&|k| std::env::var(k).ok()) {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "vexor");
        match cwd.filter(|d| std::path::Path::new(d).is_dir()) {
            Some(dir) => cmd.cwd(dir),
            None => {
                if let Some(home) = std::env::var_os("HOME") {
                    cmd.cwd(home);
                }
            }
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let pid = child.process_id();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        self.0.lock().unwrap().insert(id, Session { pid, master: pair.master, writer, child });

        thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            let mut pending: Vec<u8> = Vec::new(); // bytes UTF-8 incompletos entre lecturas
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let valid = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) if e.error_len().is_none() => e.valid_up_to(), // secuencia cortada al final
                            Err(_) => pending.len(), // inválido de verdad: lossy
                        };
                        if valid > 0 {
                            let chunk: Vec<u8> = pending.drain(..valid).collect();
                            on_data(String::from_utf8_lossy(&chunk).into_owned());
                        }
                    }
                }
            }
            on_exit();
        });
        Ok(())
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut map = self.0.lock().unwrap();
        let s = map.get_mut(&id).ok_or("sesión inexistente")?;
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.0.lock().unwrap();
        let s = map.get(&id).ok_or("sesión inexistente")?;
        s.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    /// Proceso en primer plano si no es el propio shell (p. ej. `nvim`, `sleep`).
    pub fn fg(&self, id: u32) -> Option<String> {
        let map = self.0.lock().unwrap();
        let s = map.get(&id)?;
        let pgid = s.master.process_group_leader()?;
        if Some(pgid as u32) == s.pid {
            return None;
        }
        std::fs::read_to_string(format!("/proc/{pgid}/comm")).ok().map(|c| c.trim().to_string())
    }

    /// Directorio actual del shell (Linux: /proc/<pid>/cwd).
    pub fn cwd(&self, id: u32) -> Option<String> {
        let pid = self.0.lock().unwrap().get(&id)?.pid?;
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().into_owned())
    }

    pub fn kill(&self, id: u32) {
        if let Some(mut s) = self.0.lock().unwrap().remove(&id) {
            let _ = s.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn spawn_in_cwd_reads_cwd_and_utf8() {
        let s = Sessions::default();
        let (tx, rx) = mpsc::channel();
        let (txe, rxe) = mpsc::channel();
        s.spawn(7, 80, 24, Some("/tmp".into()), Some("/bin/bash".into()), false, move |d| { tx.send(d).unwrap(); }, move || { txe.send(()).unwrap(); }).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(s.cwd(7).as_deref(), Some("/tmp"));
        s.write(7, "echo héllo-ñ $((6*7))\nexit\n").unwrap();
        rxe.recv_timeout(Duration::from_secs(5)).unwrap();
        let out: String = rx.try_iter().collect();
        assert!(out.contains("héllo-ñ 42"), "{out}");
    }

    #[test]
    fn integration_emits_osc133_and_fg_detection() {
        std::env::set_var("XDG_CONFIG_HOME", std::env::temp_dir().join("vexor-test-cfg2"));
        let s = Sessions::default();
        let (tx, rx) = mpsc::channel();
        let (txe, rxe) = mpsc::channel();
        s.spawn(8, 80, 24, Some("/tmp".into()), Some("/bin/bash".into()), true, move |d| { tx.send(d).unwrap(); }, move || { txe.send(()).unwrap(); }).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(s.fg(8), None, "el shell en reposo no es proceso en primer plano");
        s.write(8, "sleep 3 &\nfg\n").unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(s.fg(8).as_deref(), Some("sleep"));
        s.write(8, "\x03").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        s.write(8, "true\nexit\n").unwrap();
        rxe.recv_timeout(Duration::from_secs(5)).unwrap();
        let out: String = rx.try_iter().collect();
        assert!(out.contains("\x1b]133;A\x07"), "falta marca A: {out:?}");
        assert!(out.contains("\x1b]133;C\x07"), "falta marca C: {out:?}");
        assert!(out.contains("\x1b]133;D;0\x07"), "falta marca D: {out:?}");
    }

    #[test]
    fn forces_utf8_locale_when_missing() {
        let env = |pairs: Vec<(&'static str, &'static str)>| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(utf8_env(&env(vec![])), vec![("LC_CTYPE".to_string(), "C.UTF-8".to_string())]);
        assert_eq!(utf8_env(&env(vec![("LANG", "C")])), vec![("LC_CTYPE".to_string(), "C.UTF-8".to_string())]);
        assert_eq!(utf8_env(&env(vec![("LC_ALL", "POSIX")])), vec![("LC_ALL".to_string(), "C.UTF-8".to_string())]);
        assert!(utf8_env(&env(vec![("LANG", "es_AR.UTF-8")])).is_empty());
        assert!(utf8_env(&env(vec![("LANG", "C"), ("LC_CTYPE", "en_US.utf8")])).is_empty());
        assert!(utf8_env(&env(vec![("LC_ALL", "es_ES.UTF-8"), ("LANG", "C")])).is_empty());
    }
}
