#!/usr/bin/env bash
# Pruebas end-to-end de la interfaz (modo navegador + servidor Node con PTY reales).
# Requiere: Playwright con Chromium (NODE_PATH apuntando a la instalación de playwright), python3 y git.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
cd "$ROOT"
for port in 4173 4174 11500; do
  if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "El puerto $port está ocupado: cierra el proceso que lo usa y repite." >&2; exit 1; fi
done
npm run build --silent
mkdir -p "$TMP/home/.ssh"
printf 'Host *\n  User x\nHost prod web1\n  HostName 10.0.0.1\n' > "$TMP/home/.ssh/config"
printf 'git status\nls -la\ndocker compose up\ncargo build --release\n' > "$TMP/home/.bash_history"
mkdir -p "$TMP/proj"
echo '{"name":"demo","scripts":{"hello":"echo hello-task","build":"echo construyendo"}}' > "$TMP/proj/package.json"
printf 'mk:\n\techo make-ok\n' > "$TMP/proj/Makefile"
echo '{"ai":{"provider":"openai","baseUrl":"http://127.0.0.1:11500/v1","model":"mock-demo"}}' > "$TMP/cfg.json"
echo '{"ai":{"provider":"openai","baseUrl":"http://127.0.0.1:11500/v1","model":"mock-demo"},"restoreSession":false}' > "$TMP/cfg2.json"
export FAKE_DOCKER_STATE="$TMP/docker.json"
node tests/e2e/mock-ai.cjs & sleep 0.3
COMMON=(HOME="$TMP/home" PATH="$ROOT/tests/e2e/bin:$PATH" SHELL=/bin/bash VEXOR_BASHRC="$ROOT/tests/e2e/bashrc" VEXOR_CWD="$ROOT")
env "${COMMON[@]}" VEXOR_CONFIG="$TMP/cfg.json" PORT=4173 node dev/server.js >"$TMP/s1.log" 2>&1 &
env "${COMMON[@]}" VEXOR_CONFIG="$TMP/cfg2.json" PORT=4174 VEXOR_LAUNCH='{"cwd":"/tmp","command":"echo desde-cli","noRestore":true}' node dev/server.js >"$TMP/s2.log" 2>&1 &
sleep 1.5
export NODE_PATH="${NODE_PATH:-$(npm root -g)}" E2E_TMP="$TMP" E2E_ROOT="$ROOT"
node tests/e2e/e2e.cjs
