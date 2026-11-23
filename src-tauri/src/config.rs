//! Configuración persistente en ~/.config/vexor/config.json (permisos 0600: guarda la API key).
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

pub fn path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("vexor").join("config.json")
}

pub fn load() -> Value {
    fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

pub fn save(v: &Value) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&p, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Mezcla profunda: los objetos se fusionan, el resto (incluidos arrays) se reemplaza.
pub fn merge(a: &mut Value, b: Value) {
    match b {
        Value::Object(y) if a.is_object() => {
            let x = a.as_object_mut().unwrap();
            for (k, v) in y {
                merge(x.entry(k).or_insert(Value::Null), v);
            }
        }
        other => *a = other,
    }
}

pub fn env_key(provider: &str) -> Option<String> {
    let var = if provider == "anthropic" { "ANTHROPIC_API_KEY" } else { "OPENAI_API_KEY" };
    std::env::var(var).ok().filter(|s| !s.is_empty())
}

/// Vista para el frontend: nunca devuelve la API key.
pub fn public() -> Value {
    let mut c = load();
    let provider = c["ai"]["provider"].as_str().unwrap_or("anthropic").to_string();
    let stored = c["ai"]["apiKey"].as_str().map_or(false, |s| !s.is_empty());
    let has = stored || env_key(&provider).is_some();
    if let Some(ai) = c.as_object_mut().and_then(|o| o.get_mut("ai")).and_then(|v| v.as_object_mut()) {
        ai.remove("apiKey");
    }
    merge(&mut c, json!({ "ai": { "hasKey": has } }));
    c["_home"] = json!(std::env::var("HOME").unwrap_or_default());
    c
}

pub fn set(mut patch: Value) -> Result<(), String> {
    // Una API key vacía significa "no cambiar".
    if let Some(ai) = patch.get_mut("ai").and_then(|v| v.as_object_mut()) {
        if ai.get("apiKey").and_then(|k| k.as_str()).map_or(false, |k| k.trim().is_empty()) {
            ai.remove("apiKey");
        }
        ai.remove("hasKey");
    }
    if let Some(o) = patch.as_object_mut() {
        o.remove("_home");
    }
    let mut cur = load();
    merge(&mut cur, patch);
    save(&cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_objects_deep_and_arrays_replaced() {
        let mut a = json!({ "ai": { "model": "x", "baseUrl": "u" }, "snippets": [1, 2, 3] });
        merge(&mut a, json!({ "ai": { "model": "y" }, "snippets": [9] }));
        assert_eq!(a["ai"]["model"], "y");
        assert_eq!(a["ai"]["baseUrl"], "u");
        assert_eq!(a["snippets"], json!([9]));
    }
}
