//! Herramientas del panel lateral: historial de comandos, procesos, puertos, tareas de proyecto y explorador de archivos.
//! Los parsers son funciones puras para poder probarlos sin tocar el sistema.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

/* ───────── Historial de comandos ───────── */

/// Interpreta bash (una orden por línea), zsh extendido (`: 123:0;cmd`) y fish (`- cmd: cmd`).
pub fn parse_history(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim_end();
            if l.is_empty() || l.starts_with('#') && l[1..].chars().all(|c| c.is_ascii_digit()) {
                return None; // marcas de tiempo de bash (#1700000000)
            }
            if let Some(rest) = l.strip_prefix(": ") {
                return rest.split_once(';').map(|(_, c)| c.to_string()).filter(|c| !c.is_empty());
            }
            if let Some(c) = l.strip_prefix("- cmd: ") {
                return Some(c.to_string());
            }
            if l.starts_with("  when:") || l.starts_with("  paths:") || l.starts_with("    - ") {
                return None;
            }
            Some(l.to_string())
        })
        .collect()
}

/// Los más recientes primero y sin duplicados.
pub fn recent_unique(cmds: Vec<String>, limit: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for c in cmds.into_iter().rev() {
        let t = c.trim().to_string();
        if t.len() > 1 && seen.insert(t.clone()) {
            out.push(t);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

pub fn history(limit: usize) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut files: Vec<PathBuf> = Vec::new();
    if let Ok(h) = std::env::var("HISTFILE") {
        files.push(h.into());
    }
    for f in [".bash_history", ".zsh_history", ".local/share/fish/fish_history"] {
        files.push(Path::new(&home).join(f));
    }
    files.retain(|f| f.is_file());
    files.dedup();
    files.sort_by_key(|f| fs::metadata(f).and_then(|m| m.modified()).ok()); // el más reciente al final
    let mut all = Vec::new();
    for f in files {
        if let Ok(bytes) = fs::read(&f) {
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.lines().collect();
            let tail = lines[lines.len().saturating_sub(20000)..].join("\n");
            all.extend(parse_history(&tail));
        }
    }
    recent_unique(all, limit)
}

/* ───────── Procesos y puertos ───────── */

fn take_field(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    Some((&s[..end], &s[end..]))
}

/// Salida de `ps -eo pid=,user=,pcpu=,pmem=,etime=,comm=,args=`.
pub fn parse_ps(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| {
            let (pid, r) = take_field(line)?;
            let (user, r) = take_field(r)?;
            let (cpu, r) = take_field(r)?;
            let (mem, r) = take_field(r)?;
            let (time, r) = take_field(r)?;
            let (name, r) = take_field(r)?;
            Some(json!({
                "pid": pid.parse::<u32>().ok()?, "user": user, "cpu": cpu.parse::<f64>().unwrap_or(0.0),
                "mem": mem.parse::<f64>().unwrap_or(0.0), "time": time, "name": name, "cmd": r.trim()
            }))
        })
        .collect()
}

/// Salida de `ss -H -tulpn`.
pub fn parse_ports(text: &str) -> Vec<Value> {
    let mut out: Vec<Value> = text
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 5 {
                return None;
            }
            let (addr, port) = f[4].rsplit_once(':')?;
            let port: u16 = port.parse().ok()?;
            let (mut name, mut pid) = (String::new(), 0u32);
            if let Some(i) = line.find("users:((\"") {
                let rest = &line[i + 9..];
                name = rest.split('"').next().unwrap_or("").to_string();
                if let Some(j) = rest.find("pid=") {
                    pid = rest[j + 4..].split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(0);
                }
            }
            Some(json!({ "proto": f[0], "state": f[1], "addr": addr.trim_matches(|c| c == '[' || c == ']'), "port": port, "process": name, "pid": pid }))
        })
        .collect();
    out.sort_by_key(|v| v["port"].as_u64().unwrap_or(0));
    out.dedup_by(|a, b| a["port"] == b["port"] && a["proto"] == b["proto"] && a["pid"] == b["pid"]);
    out
}

/* ───────── Tareas de proyecto ───────── */

pub fn parse_package_scripts(text: &str) -> Vec<(String, String)> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v["scripts"].as_object().cloned())
        .map(|m| m.into_iter().map(|(k, v)| (k, v.as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default()
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && !n.starts_with('.') && n.chars().all(|c| c.is_ascii_alphanumeric() || "_-./".contains(c))
}

pub fn parse_makefile(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with(['\t', ' ', '#']) || line.is_empty() {
            continue;
        }
        let Some(i) = line.find(':') else { continue };
        if line[i + 1..].starts_with('=') || line[..i].contains(['=', '$', '%', '(']) {
            continue;
        }
        for n in line[..i].split_whitespace() {
            if valid_name(n) && !out.iter().any(|x| x == n) {
                out.push(n.to_string());
            }
        }
    }
    out
}

pub fn parse_justfile(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with(['\t', ' ', '#']) || line.is_empty() || line.contains(":=") {
            continue;
        }
        let Some(i) = line.find(':') else { continue };
        let name = line[..i].trim().trim_start_matches('@').split_whitespace().next().unwrap_or("");
        if valid_name(name) && !["set", "alias", "export", "import", "mod"].contains(&name) && !out.iter().any(|x| x == name) {
            out.push(name.to_string());
        }
    }
    out
}

fn group(kind: &str, file: &str, tasks: Vec<(String, String)>) -> Value {
    json!({ "kind": kind, "file": file, "tasks": tasks.into_iter().map(|(n, c)| json!({ "name": n, "cmd": c })).collect::<Vec<_>>() })
}

fn detect(dir: &Path) -> Vec<Value> {
    let mut groups = Vec::new();
    let read = |f: &str| fs::read_to_string(dir.join(f)).ok();
    if let Some(t) = read("package.json") {
        let pm = if dir.join("pnpm-lock.yaml").exists() { "pnpm run" }
            else if dir.join("yarn.lock").exists() { "yarn" }
            else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() { "bun run" }
            else { "npm run" };
        let scripts = parse_package_scripts(&t);
        if !scripts.is_empty() {
            groups.push(group("npm", "package.json", scripts.into_iter().map(|(n, _)| (n.clone(), format!("{pm} {n}"))).collect()));
        }
    }
    if dir.join("Cargo.toml").exists() {
        let t = ["build", "build --release", "run", "test", "check", "clippy", "fmt"];
        groups.push(group("cargo", "Cargo.toml", t.iter().map(|x| (x.to_string(), format!("cargo {x}"))).collect()));
    }
    for f in ["Makefile", "makefile", "GNUmakefile"] {
        if let Some(t) = read(f) {
            let ts = parse_makefile(&t);
            if !ts.is_empty() { groups.push(group("make", f, ts.into_iter().map(|n| (n.clone(), format!("make {n}"))).collect())); }
            break;
        }
    }
    for f in ["justfile", "Justfile"] {
        if let Some(t) = read(f) {
            let ts = parse_justfile(&t);
            if !ts.is_empty() { groups.push(group("just", f, ts.into_iter().map(|n| (n.clone(), format!("just {n}"))).collect())); }
            break;
        }
    }
    for f in ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] {
        if dir.join(f).exists() {
            let t = [("up -d", "up -d"), ("down", "down"), ("logs -f", "logs -f"), ("ps", "ps"), ("build", "build")];
            groups.push(group("compose", f, t.iter().map(|(n, a)| (n.to_string(), format!("docker compose {a}"))).collect()));
            break;
        }
    }
    groups
}

/// Busca el proyecto subiendo desde `cwd` (máx. 6 niveles) y devuelve las tareas que encuentra.
pub fn project_tasks(cwd: &str) -> Value {
    let mut dir = PathBuf::from(cwd);
    for _ in 0..6 {
        let groups = detect(&dir);
        if !groups.is_empty() {
            return json!({ "root": dir.to_string_lossy(), "groups": groups });
        }
        if !dir.pop() { break; }
    }
    json!({ "root": cwd, "groups": [] })
}

/* ───────── Explorador de archivos ───────── */

pub fn list_dir(path: &str, hidden: bool) -> Result<Value, String> {
    let expanded = if let Some(rest) = path.strip_prefix('~') {
        format!("{}{}", std::env::var("HOME").unwrap_or_default(), rest)
    } else {
        path.to_string()
    };
    let dir = fs::canonicalize(&expanded).map_err(|e| format!("{expanded}: {e}"))?;
    let mut entries: Vec<(bool, String, u64)> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !hidden && name.starts_with('.') { return None; }
            let md = fs::metadata(e.path()).or_else(|_| e.metadata()).ok()?;
            Some((md.is_dir(), name, md.len()))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let truncated = entries.len() > 1000;
    entries.truncate(1000);
    Ok(json!({
        "path": dir.to_string_lossy(),
        "parent": dir.parent().map(|p| p.to_string_lossy().into_owned()),
        "entries": entries.into_iter().map(|(d, n, s)| json!({ "name": n, "dir": d, "size": s })).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_formats() {
        let b = parse_history("#1700000000\nls -la\ngit status\n\nls -la\n");
        assert_eq!(b, vec!["ls -la", "git status", "ls -la"]);
        let z = parse_history(": 1700000000:0;cargo build\n: 1700000001:0;npm test\n");
        assert_eq!(z, vec!["cargo build", "npm test"]);
        let f = parse_history("- cmd: docker ps\n  when: 1700000000\n- cmd: ls\n  when: 1\n");
        assert_eq!(f, vec!["docker ps", "ls"]);
        let r = recent_unique(vec!["a1".into(), "b1".into(), "a1".into(), "c1".into()], 10);
        assert_eq!(r, vec!["c1", "a1", "b1"]);
        assert_eq!(recent_unique(vec!["x1".into(), "y1".into(), "z1".into()], 2), vec!["z1", "y1"]);
    }

    #[test]
    fn ps_and_ports() {
        let p = parse_ps("    1 root      0.0  0.1    05:10 systemd         /sbin/init splash\n 4242 usuario  12.5  3.2 1-02:03:04 node         node server.js --port 3000\n");
        assert_eq!(p.len(), 2);
        assert_eq!(p[1]["pid"], 4242);
        assert_eq!(p[1]["cpu"], 12.5);
        assert_eq!(p[1]["time"], "1-02:03:04");
        assert_eq!(p[1]["cmd"], "node server.js --port 3000");
        let s = "tcp   LISTEN 0 128 0.0.0.0:8765 0.0.0.0:* users:((\"python3\",pid=123,fd=3))\ntcp   LISTEN 0 4096 [::]:22 [::]:* \nudp   UNCONN 0 0 127.0.0.53:53 0.0.0.0:* users:((\"systemd-resolve\",pid=9,fd=13))\n";
        let o = parse_ports(s);
        assert_eq!(o.len(), 3);
        assert_eq!(o[0]["port"], 22);
        assert_eq!(o[0]["addr"], "::");
        assert_eq!(o[2]["port"], 8765);
        assert_eq!(o[2]["process"], "python3");
        assert_eq!(o[2]["pid"], 123);
    }

    #[test]
    fn project_files() {
        assert_eq!(parse_package_scripts(r#"{"scripts":{"dev":"vite","build":"vite build"}}"#).len(), 2);
        assert!(parse_package_scripts("no json").is_empty());
        let m = parse_makefile("CC := gcc\nVAR = 1\n.PHONY: all\nall: build test\n\t@echo hi\nbuild:\n\tcc\n%.o: %.c\ntest: build\n");
        assert_eq!(m, vec!["all", "build", "test"]);
        let j = parse_justfile("set shell := [\"bash\"]\nversion := \"1\"\n# c\nbuild:\n  cargo build\n@fmt arg='x':\n  cargo fmt\n");
        assert_eq!(j, vec!["build", "fmt"]);
    }

    #[test]
    fn detect_and_list() {
        let d = std::env::temp_dir().join(format!("vexor-tools-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("sub/inner")).unwrap();
        fs::write(d.join("package.json"), r#"{"scripts":{"hello":"echo hi"}}"#).unwrap();
        fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        fs::write(d.join("Makefile"), "all:\n\techo\n").unwrap();
        fs::write(d.join(".oculto"), "x").unwrap();
        fs::write(d.join("b.txt"), "12345").unwrap();
        let t = project_tasks(d.join("sub/inner").to_str().unwrap()); // sube hasta encontrar el proyecto
        assert_eq!(t["root"], d.to_string_lossy().as_ref());
        assert_eq!(t["groups"][0]["kind"], "npm");
        assert_eq!(t["groups"][0]["tasks"][0]["cmd"], "pnpm run hello");
        assert_eq!(t["groups"][1]["kind"], "make");
        let l = list_dir(d.to_str().unwrap(), false).unwrap();
        let names: Vec<&str> = l["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["sub", "b.txt", "Makefile", "package.json", "pnpm-lock.yaml"]);
        assert!(list_dir(d.to_str().unwrap(), true).unwrap()["entries"].as_array().unwrap().iter().any(|e| e["name"] == ".oculto"));
        assert!(list_dir("/no/existe/seguro", false).is_err());
        let _ = fs::remove_dir_all(&d);
    }
}
