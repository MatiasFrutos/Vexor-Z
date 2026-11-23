//! Integración de shell (OSC 133). Se inyecta al lanzar el shell, sin tocar los archivos del usuario:
//! bash → `--rcfile` (que carga ~/.bashrc y después el script), zsh → `ZDOTDIR`, fish → `--init-command`.
use std::{
    fs,
    path::{Path, PathBuf},
};

const BASH: &str = include_str!("../shell/vexor.bash");
const ZSH: &str = include_str!("../shell/vexor.zsh");
const FISH: &str = include_str!("../shell/vexor.fish");

pub fn dir() -> PathBuf {
    crate::config::path().parent().map(|p| p.join("shell")).unwrap_or_else(|| PathBuf::from("shell"))
}

fn write_if_changed(path: &Path, content: &str) {
    if fs::read_to_string(path).ok().as_deref() != Some(content) {
        if let Some(d) = path.parent() {
            let _ = fs::create_dir_all(d);
        }
        let _ = fs::write(path, content);
    }
}

pub fn ensure_files() -> PathBuf {
    let d = dir();
    let s = d.to_string_lossy();
    write_if_changed(&d.join("vexor.bash"), BASH);
    write_if_changed(&d.join("vexor.zsh"), ZSH);
    write_if_changed(&d.join("vexor.fish"), FISH);
    write_if_changed(
        &d.join("bashrc"),
        &format!("# Generado por Vexor: carga tu ~/.bashrc y después la integración.\n[ -f \"$HOME/.bashrc\" ] && . \"$HOME/.bashrc\"\n. \"{s}/vexor.bash\"\n"),
    );
    write_if_changed(
        &d.join("zsh").join(".zshenv"),
        "# Generado por Vexor\n[[ -f \"${VEXOR_USER_ZDOTDIR:-$HOME}/.zshenv\" ]] && source \"${VEXOR_USER_ZDOTDIR:-$HOME}/.zshenv\"\n",
    );
    write_if_changed(
        &d.join("zsh").join(".zshrc"),
        &format!("# Generado por Vexor\nZDOTDIR=\"${{VEXOR_USER_ZDOTDIR:-$HOME}}\"\n[[ -f \"$ZDOTDIR/.zshrc\" ]] && source \"$ZDOTDIR/.zshrc\"\nsource \"{s}/vexor.zsh\"\n"),
    );
    d
}

/// Argumentos y variables de entorno extra para lanzar `shell` con la integración activa.
pub fn setup(shell: &str) -> (Vec<String>, Vec<(String, String)>) {
    let name = Path::new(shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match name.as_str() {
        "bash" => {
            let d = ensure_files();
            (vec!["--rcfile".into(), d.join("bashrc").to_string_lossy().into_owned(), "-i".into()], vec![])
        }
        "zsh" => {
            let d = ensure_files();
            let user = std::env::var("ZDOTDIR").ok().or_else(|| std::env::var("HOME").ok()).unwrap_or_default();
            (vec![], vec![("ZDOTDIR".into(), d.join("zsh").to_string_lossy().into_owned()), ("VEXOR_USER_ZDOTDIR".into(), user)])
        }
        "fish" => {
            let d = ensure_files();
            (vec!["--init-command".into(), format!("source '{}'", d.join("vexor.fish").to_string_lossy())], vec![])
        }
        _ => (vec![], vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_per_shell() {
        std::env::set_var("XDG_CONFIG_HOME", std::env::temp_dir().join("vexor-test-cfg"));
        let (a, e) = setup("/usr/bin/bash");
        assert_eq!(a[0], "--rcfile");
        assert!(e.is_empty() && std::path::Path::new(&a[1]).exists());
        let (a, e) = setup("/usr/bin/zsh");
        assert!(a.is_empty() && e.iter().any(|(k, _)| k == "ZDOTDIR"));
        let (a, _) = setup("/usr/bin/fish");
        assert_eq!(a[0], "--init-command");
        let (a, e) = setup("/bin/dash");
        assert!(a.is_empty() && e.is_empty());
    }
}
