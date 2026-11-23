//! Utilidades puras (parseo de /proc, git y docker). Sin dependencias de Tauri, así se pueden probar.
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
pub struct SysStats {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub load: f32,
    pub net_rx: u64,
    pub net_tx: u64,
    pub uptime: f64,
}

static LAST_CPU: Mutex<Option<(u64, u64)>> = Mutex::new(None);

/// Devuelve (idle, total) a partir de la línea "cpu ..." de /proc/stat.
pub fn parse_cpu(stat: &str) -> Option<(u64, u64)> {
    let line = stat.lines().next()?;
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    if v.len() < 5 {
        return None;
    }
    let idle = v[3] + v[4];
    let total: u64 = v.iter().take(8).sum();
    Some((idle, total))
}

/// Devuelve (usada, total) en bytes a partir de /proc/meminfo.
pub fn parse_meminfo(s: &str) -> (u64, u64) {
    let get = |k: &str| {
        s.lines()
            .find(|l| l.starts_with(k))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    let total = get("MemTotal:");
    (total.saturating_sub(get("MemAvailable:")), total)
}

/// Bytes recibidos y enviados (acumulados) sumando todas las interfaces de /proc/net/dev salvo `lo`.
pub fn parse_net(s: &str) -> (u64, u64) {
    let (mut rx, mut tx) = (0u64, 0u64);
    for line in s.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else { continue };
        if name.trim() == "lo" {
            continue;
        }
        let f: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if f.len() >= 9 {
            rx += f[0];
            tx += f[8];
        }
    }
    (rx, tx)
}

/// Salida de `df -kP`: discos con su uso en bytes.
pub fn parse_df(s: &str) -> Vec<Value> {
    s.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 6 {
                return None;
            }
            let total = f[1].parse::<u64>().ok()? * 1024;
            let used = f[2].parse::<u64>().ok()? * 1024;
            if total == 0 {
                return None;
            }
            Some(json!({ "fs": f[0], "mount": f[5..].join(" "), "used": used, "total": total }))
        })
        .collect()
}

pub fn stats() -> SysStats {
    let mut out = SysStats::default();
    if let Ok(s) = std::fs::read_to_string("/proc/stat") {
        if let Some((idle, total)) = parse_cpu(&s) {
            let mut last = LAST_CPU.lock().unwrap();
            if let Some((li, lt)) = *last {
                let dt = total.saturating_sub(lt) as f32;
                if dt > 0.0 {
                    out.cpu = ((1.0 - idle.saturating_sub(li) as f32 / dt) * 100.0).clamp(0.0, 100.0);
                }
            }
            *last = Some((idle, total));
        }
    }
    if let Ok(s) = std::fs::read_to_string("/proc/meminfo") {
        let (u, t) = parse_meminfo(&s);
        out.mem_used = u;
        out.mem_total = t;
    }
    if let Ok(s) = std::fs::read_to_string("/proc/net/dev") {
        let (rx, tx) = parse_net(&s);
        out.net_rx = rx;
        out.net_tx = tx;
    }
    if let Ok(s) = std::fs::read_to_string("/proc/uptime") {
        out.uptime = s.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    }
    if let Ok(s) = std::fs::read_to_string("/proc/loadavg") {
        out.load = s.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    }
    out
}

/// Interpreta `git status --porcelain=v1 -b` y `git log --pretty=%h\t%s\t%cr`.
pub fn parse_git(status: &str, log: &str) -> Value {
    let mut branch = String::new();
    let (mut ahead, mut behind) = (0u32, 0u32);
    let mut files = Vec::new();
    for line in status.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            let name = h.split("...").next().unwrap_or(h);
            branch = name.split(' ').next().unwrap_or(name).to_string();
            if h.starts_with("No commits yet on ") {
                branch = h.trim_start_matches("No commits yet on ").to_string();
            }
            if let Some(i) = h.find('[') {
                for part in h[i + 1..].trim_end_matches(']').split(',') {
                    let part = part.trim();
                    if let Some(n) = part.strip_prefix("ahead ") { ahead = n.parse().unwrap_or(0); }
                    if let Some(n) = part.strip_prefix("behind ") { behind = n.parse().unwrap_or(0); }
                }
            }
        } else if line.len() > 3 {
            files.push(json!({ "status": line[..2].trim(), "path": &line[3..] }));
        }
    }
    let commits: Vec<Value> = log
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            Some(json!({ "hash": p.next()?, "subject": p.next()?, "when": p.next().unwrap_or("") }))
        })
        .collect();
    json!({ "branch": branch, "ahead": ahead, "behind": behind, "files": files, "commits": commits })
}

/// Hosts de `~/.ssh/config` (sin patrones con comodines).
pub fn parse_ssh_hosts(cfg: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in cfg.lines() {
        let l = line.trim();
        let lower = l.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("host ").or_else(|| lower.strip_prefix("host\t")) {
            let _ = rest;
            for h in l[5..].split_whitespace() {
                if !h.contains(['*', '?', '!']) && !out.iter().any(|x| x == h) {
                    out.push(h.to_string());
                }
            }
        }
    }
    out
}

/// Argumentos de línea de comandos al estilo Alacritty.
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub no_restore: bool,
    pub title: Option<String>,
}

pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-./=:@%+,".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

pub fn parse_args(args: &[String]) -> LaunchArgs {
    let mut out = LaunchArgs::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--working-directory" | "-w" => { out.cwd = args.get(i + 1).cloned(); i += 1; }
            "--title" | "-T" => { out.title = args.get(i + 1).cloned(); i += 1; }
            "--no-restore" => out.no_restore = true,
            "-e" | "--command" => {
                let rest: Vec<String> = args[i + 1..].iter().map(|a| shell_quote(a)).collect();
                if !rest.is_empty() { out.command = Some(rest.join(" ")); }
                break;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_and_mem() {
        let (idle, total) = parse_cpu("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4 5").unwrap();
        assert_eq!((idle, total), (850, 1000));
        assert_eq!(parse_cpu("nada"), None);
        let (used, tot) = parse_meminfo("MemTotal:  16000 kB\nMemFree: 1 kB\nMemAvailable:  4000 kB\n");
        assert_eq!((used, tot), (12000 * 1024, 16000 * 1024));
    }

    #[test]
    fn git_status_and_log() {
        let v = parse_git(
            "## main...origin/main [ahead 2, behind 1]\n M src/a.rs\n?? nuevo.txt\nR  viejo -> nuevo\n",
            "abc123\tPrimer commit\thace 2 días\ndef456\tSegundo\thace 1 hora",
        );
        assert_eq!(v["branch"], "main");
        assert_eq!(v["ahead"], 2);
        assert_eq!(v["behind"], 1);
        assert_eq!(v["files"].as_array().unwrap().len(), 3);
        assert_eq!(v["files"][0]["status"], "M");
        assert_eq!(v["files"][1]["status"], "??");
        assert_eq!(v["files"][2]["path"], "viejo -> nuevo");
        assert_eq!(v["commits"][1]["subject"], "Segundo");
        let sin = parse_git("## No commits yet on master\n", "");
        assert_eq!(sin["branch"], "master");
    }

    #[test]
    fn net_and_df() {
        let net = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 1000 5 0 0 0 0 0 0 2000 6 0 0 0 0 0 0\n wlan0: 50 1 0 0 0 0 0 0 70 1 0 0 0 0 0 0\n";
        assert_eq!(parse_net(net), (1050, 2070));
        let df = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/nvme0n1p2   488000000 122000000 366000000      25% /\n/dev/sda1          1000000    500000    500000      50% /mnt/Mi Disco\nnone 0 0 0 - /proc\n";
        let d = parse_df(df);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0]["mount"], "/");
        assert_eq!(d[0]["total"], 488000000u64 * 1024);
        assert_eq!(d[1]["mount"], "/mnt/Mi Disco");
        assert_eq!(d[1]["used"], 500000u64 * 1024);
    }

    #[test]
    fn stats_runs() {
        let s = stats();
        assert!(s.mem_total > 0);
    }

    #[test]
    fn ssh_hosts_and_args() {
        let h = parse_ssh_hosts("Host *\n  User x\nHost prod web1\n  HostName 1.2.3.4\nhost db-*\nHost staging\nHost prod\n");
        assert_eq!(h, vec!["prod", "web1", "staging"]);
        let a = |v: &[&str]| parse_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(a(&[]), LaunchArgs::default());
        let l = a(&["--working-directory", "/tmp", "--no-restore", "-T", "Mi título", "-e", "btop", "--tree", "a b"]);
        assert_eq!(l.cwd.as_deref(), Some("/tmp"));
        assert!(l.no_restore);
        assert_eq!(l.title.as_deref(), Some("Mi título"));
        assert_eq!(l.command.as_deref(), Some("btop --tree 'a b'"));
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
