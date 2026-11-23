//! Cliente de IA con streaming. Soporta la API de Anthropic y cualquier API compatible con OpenAI
//! (Ollama, LM Studio, OpenRouter, vLLM…).
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct AiRequest {
    pub system: String,
    pub messages: Vec<Msg>,
}

#[derive(Default, Clone)]
pub struct AiState(pub Arc<Mutex<HashSet<u32>>>);

fn emit(app: &AppHandle, id: u32, kind: &str, text: &str) {
    let _ = app.emit("ai-event", json!({ "id": id, "kind": kind, "text": text }));
}

fn trunc(s: &str) -> String {
    s.chars().take(400).collect()
}

pub async fn run(app: AppHandle, id: u32, cfg: Value, req: AiRequest, state: AiState) {
    let result = stream(&app, id, &cfg, req, &state).await;
    { let mut s = state.0.lock().unwrap(); s.remove(&id); s.remove(&(u32::MAX - id)); }
    match result {
        Ok(()) => emit(&app, id, "done", ""),
        Err(e) => emit(&app, id, "error", &e),
    }
}

async fn stream(app: &AppHandle, id: u32, cfg: &Value, req: AiRequest, state: &AiState) -> Result<(), String> {
    let provider = cfg["provider"].as_str().unwrap_or("anthropic");
    let anthropic = provider == "anthropic";
    let default_base = if anthropic { "https://api.anthropic.com" } else { "http://localhost:11434/v1" };
    let base = cfg["baseUrl"].as_str().filter(|s| !s.is_empty()).unwrap_or(default_base).trim_end_matches('/').to_string();
    let model = cfg["model"].as_str().filter(|s| !s.is_empty()).unwrap_or(if anthropic { "claude-sonnet-5-5" } else { "llama3.2" });
    let key = cfg["apiKey"].as_str().filter(|s| !s.is_empty()).map(String::from).or_else(|| crate::config::env_key(provider));

    let client = reqwest::Client::new();
    let rb = if anthropic {
        let key = key.ok_or("Falta la API key de Anthropic (Ajustes → IA).")?;
        client
            .post(format!("{base}/v1/messages"))
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model, "max_tokens": 4096, "stream": true,
                "system": req.system,
                "messages": req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
            }))
    } else {
        let mut msgs = vec![json!({"role": "system", "content": req.system})];
        msgs.extend(req.messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
        let mut b = client.post(format!("{base}/chat/completions")).json(&json!({"model": model, "stream": true, "messages": msgs}));
        if let Some(k) = key {
            b = b.bearer_auth(k);
        }
        b
    };

    let resp = rb.send().await.map_err(|e| format!("No se pudo conectar con {base}: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", trunc(&body)));
    }

    let mut bytes = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = bytes.next().await {
        if state.0.lock().unwrap().contains(&(u32::MAX - id)) {
            return Ok(()); // cancelado
        }
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if anthropic {
                match v["type"].as_str() {
                    Some("content_block_delta") => {
                        if let Some(t) = v["delta"]["text"].as_str() {
                            emit(app, id, "chunk", t);
                        }
                    }
                    Some("error") => return Err(v["error"]["message"].as_str().unwrap_or("error de la API").to_string()),
                    _ => {}
                }
            } else if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                emit(app, id, "chunk", t);
            }
        }
    }
    Ok(())
}
