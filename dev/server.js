// Servidor del modo navegador: sirve dist/ y expone PTYs reales + las mismas funciones que el backend Rust
// (cwd, git, which, configuración e IA con streaming) por WebSocket. Solo para desarrollo/pruebas de UI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const notifications = [];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/__notifications') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(notifications)); }
  const f = path.join(root, u === '/' ? 'index.html' : u);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

/* ── configuración (mismo formato que el backend Rust) ── */
const cfgPath = process.env.VEXOR_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'vexor', 'config.json');
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return {}; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v; return a; };
const envKey = (p) => process.env[p === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'];
function publicCfg() {
  const c = loadCfg();
  const provider = c.ai?.provider || 'anthropic';
  const has = !!(c.ai?.apiKey || envKey(provider));
  if (c.ai) delete c.ai.apiKey;
  return merge(c, { ai: { hasKey: has }, _home: os.homedir() });
}
function setCfg(patch) {
  if (patch.ai) { if (!patch.ai.apiKey?.trim()) delete patch.ai.apiKey; delete patch.ai.hasKey; }
  delete patch._home;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(merge(loadCfg(), patch), null, 2), { mode: 0o600 });
}

/* ── IA con streaming (Anthropic / compatible OpenAI) ── */
// Mismo criterio que el backend Rust: sin locale UTF-8, bash descarta ñ, tildes y ü al teclearlas.
const utf8Env = () => {
  const e = process.env, ne = (k) => (e[k] ? e[k] : '');
  const eff = (ne('LC_ALL') || ne('LC_CTYPE') || ne('LANG')).toLowerCase();
  return /utf-?8/.test(eff) ? {} : { [ne('LC_ALL') ? 'LC_ALL' : 'LC_CTYPE']: 'C.UTF-8' };
};
const cancelled = new Set();
let lastCpu = null;
async function streamAI(id, req, emit) {
  const cfg = loadCfg().ai || {};
  const provider = cfg.provider || 'anthropic', anth = provider === 'anthropic';
  const base = (cfg.baseUrl || (anth ? 'https://api.anthropic.com' : 'http://localhost:11434/v1')).replace(/\/$/, '');
  const model = cfg.model || (anth ? 'claude-sonnet-5-5' : 'llama3.2');
  const key = cfg.apiKey || envKey(provider);
  let url, headers = { 'content-type': 'application/json' }, body;
  if (anth) {
    if (!key) throw new Error('Falta la API key de Anthropic (Ajustes → IA).');
    url = `${base}/v1/messages`; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
    body = { model, max_tokens: 4096, stream: true, system: req.system, messages: req.messages };
  } else {
    url = `${base}/chat/completions`; if (key) headers.authorization = `Bearer ${key}`;
    body = { model, stream: true, messages: [{ role: 'system', content: req.system }, ...req.messages] };
  }
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch (e) { throw new Error(`No se pudo conectar con ${base}: ${e.message}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    if (cancelled.has(id)) return;
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let v; try { v = JSON.parse(data); } catch { continue; }
      if (anth) {
        if (v.type === 'content_block_delta' && v.delta?.text) emit('chunk', v.delta.text);
        else if (v.type === 'error') throw new Error(v.error?.message || 'error de la API');
      } else if (v.choices?.[0]?.delta?.content) emit('chunk', v.choices[0].delta.content);
    }
  }
}

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, (err, out) => res(err ? null : out)));
const rpcMethods = (ws, ptys) => ({
  cwd: ({ id }) => { const p = ptys.get(id); try { return p ? fs.readlinkSync(`/proc/${p.pid}/cwd`) : null; } catch { return null; } },
  git: async ({ cwd }) => {
    const b = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']); if (!b) return null;
    const s = await run('git', ['-C', cwd, 'status', '--porcelain']);
    return { branch: b.trim(), dirty: !!s?.trim() };
  },
  which: ({ names }) => names.map((n) => (process.env.PATH || '').split(':').some((d) => { try { fs.accessSync(path.join(d, n), fs.constants.X_OK); return fs.statSync(path.join(d, n)).isFile(); } catch { return false; } })),
  gitStatus: async ({ cwd }) => {
    const st = await run('git', ['-C', cwd, 'status', '--porcelain=v1', '-b']); if (st == null) return null;
    const log = (await run('git', ['-C', cwd, 'log', '-n', '8', '--pretty=format:%h%x09%s%x09%cr'])) || '';
    let branch = '', ahead = 0, behind = 0; const files = [];
    for (const l of st.split('\n')) {
      if (l.startsWith('## ')) {
        const hd = l.slice(3); branch = hd.startsWith('No commits yet on ') ? hd.slice(18) : hd.split('...')[0].split(' ')[0];
        ahead = +(/ahead (\d+)/.exec(hd)?.[1] || 0); behind = +(/behind (\d+)/.exec(hd)?.[1] || 0);
      } else if (l.length > 3) files.push({ status: l.slice(0, 2).trim(), path: l.slice(3) });
    }
    const commits = log.split('\n').filter(Boolean).map((x) => { const [hash, subject, when] = x.split('\t'); return { hash, subject, when }; });
    return { branch, ahead, behind, files, commits };
  },
  sys: () => {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
    const idle = stat[3] + stat[4], total = stat.slice(0, 8).reduce((a, b) => a + b, 0);
    let cpu = 0; if (lastCpu) { const dt = total - lastCpu[1]; if (dt > 0) cpu = Math.max(0, Math.min(100, (1 - (idle - lastCpu[0]) / dt) * 100)); }
    lastCpu = [idle, total];
    const mi = fs.readFileSync('/proc/meminfo', 'utf8'); const g = (k) => +(new RegExp(`${k}:\\s+(\\d+)`).exec(mi)?.[1] || 0) * 1024;
    let rx = 0, tx = 0;
    for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) { const [n, r] = l.split(':'); if (!r || n.trim() === 'lo') continue; const f = r.trim().split(/\s+/).map(Number); if (f.length >= 9) { rx += f[0]; tx += f[8]; } }
    return { cpu, mem_total: g('MemTotal'), mem_used: g('MemTotal') - g('MemAvailable'), load: +fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0], net_rx: rx, net_tx: tx, uptime: +fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0] };
  },
  dockerPs: () => new Promise((res, rej) => execFile('docker', ['ps', '-a', '--format', '{{json .}}'], (err, out, se) => err ? rej(new Error(err.code === 'ENOENT' ? 'Docker no está instalado o no está en el PATH' : (se || err.message).slice(0, 300))) : res(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))))),
  dockerAction: ({ action, name }) => new Promise((res, rej) => {
    if (!['start', 'stop', 'restart'].includes(action) || !/^[\w.-]+$/.test(name)) return rej(new Error('acción no permitida'));
    execFile('docker', [action, name], (err, _o, se) => err ? rej(new Error((se || err.message).slice(0, 300))) : res(null));
  }),
  fg: ({ id }) => {
    const p = ptys.get(id); if (!p) return null;
    try {
      const stat = fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8'); const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const tpgid = +f[5]; if (tpgid === p.pid || tpgid <= 0) return null;
      return fs.readFileSync(`/proc/${tpgid}/comm`, 'utf8').trim();
    } catch { return null; }
  },
  sshHosts: () => { try { return [...new Set(fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8').split('\n').filter((l) => /^\s*host\s/i.test(l)).flatMap((l) => l.trim().split(/\s+/).slice(1)).filter((h) => !/[*?!]/.test(h)))]; } catch { return []; } },
  launchArgs: () => (process.env.VEXOR_LAUNCH ? JSON.parse(process.env.VEXOR_LAUNCH) : {}),
  writeTemp: ({ name, text }) => { const d = path.join(os.tmpdir(), 'vexor'); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, name.replace(/[^\w.-]/g, '_')); fs.writeFileSync(f, text); return f; },
  notify: ({ title, body }) => { notifications.push({ title, body }); return null; },
  newWindow: () => null,
  notifications: () => notifications,
  history: ({ limit }) => {
    const home = os.homedir(); const files = [process.env.HISTFILE, path.join(home, '.bash_history'), path.join(home, '.zsh_history'), path.join(home, '.local/share/fish/fish_history')].filter((f) => f && fs.existsSync(f) && fs.statSync(f).isFile());
    files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    const all = [];
    for (const f of [...new Set(files)]) for (let l of fs.readFileSync(f, 'utf8').split('\n').slice(-20000)) {
      l = l.trimEnd(); if (!l || /^#\d+$/.test(l) || /^( {2}when:| {2}paths:| {4}- )/.test(l)) continue;
      if (l.startsWith(': ')) { const i = l.indexOf(';'); if (i > 0) all.push(l.slice(i + 1)); } else if (l.startsWith('- cmd: ')) all.push(l.slice(7)); else all.push(l);
    }
    const seen = new Set(), out = [];
    for (const c of all.reverse()) { const t = c.trim(); if (t.length > 1 && !seen.has(t)) { seen.add(t); out.push(t); if (out.length >= (limit || 2000)) break; } }
    return out;
  },
  ps: () => new Promise((res) => execFile('ps', ['-eo', 'pid=,user=,pcpu=,pmem=,etime=,comm=,args=', '--sort=-pcpu'], (err, out) => res(err ? [] : out.split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(l)).filter(Boolean).slice(0, 500).map((m) => ({ pid: +m[1], user: m[2], cpu: +m[3], mem: +m[4], time: m[5], name: m[6], cmd: m[7].trim() }))))),
  ports: () => new Promise((res, rej) => execFile('ss', ['-H', '-tulpn'], (err, out) => {
    if (err) return rej(new Error('Falta el comando `ss` (paquete iproute2)'));
    const rows = out.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 5).map((f) => {
      const i = f[4].lastIndexOf(':'); const u = /users:\(\("([^"]*)",pid=(\d+)/.exec(f.join(' '));
      return { proto: f[0], state: f[1], addr: f[4].slice(0, i).replace(/^\[|\]$/g, ''), port: +f[4].slice(i + 1), process: u ? u[1] : '', pid: u ? +u[2] : 0 };
    }).filter((r) => r.port).sort((a, b) => a.port - b.port);
    res(rows.filter((r, i) => !(i && rows[i - 1].port === r.port && rows[i - 1].proto === r.proto && rows[i - 1].pid === r.pid)));
  })),
  killProc: ({ pid, signal }) => new Promise((res, rej) => {
    if (!(pid > 1) || !['TERM', 'KILL', 'INT', 'HUP', 'STOP', 'CONT'].includes(signal)) return rej(new Error('señal o proceso no permitido'));
    execFile('kill', [`-${signal}`, String(pid)], (err, _o, se) => (err ? rej(new Error((se || err.message).trim())) : res(null)));
  }),
  projectTasks: ({ cwd }) => {
    const detect = (dir) => {
      const g = [], rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } }, ex = (f) => fs.existsSync(path.join(dir, f));
      const pj = rd('package.json');
      if (pj) { let sc = {}; try { sc = JSON.parse(pj).scripts || {}; } catch {} const pm = ex('pnpm-lock.yaml') ? 'pnpm run' : ex('yarn.lock') ? 'yarn' : (ex('bun.lockb') || ex('bun.lock')) ? 'bun run' : 'npm run'; const t = Object.keys(sc).map((n) => ({ name: n, cmd: `${pm} ${n}` })); if (t.length) g.push({ kind: 'npm', file: 'package.json', tasks: t }); }
      if (ex('Cargo.toml')) g.push({ kind: 'cargo', file: 'Cargo.toml', tasks: ['build', 'build --release', 'run', 'test', 'check', 'clippy', 'fmt'].map((x) => ({ name: x, cmd: `cargo ${x}` })) });
      for (const f of ['Makefile', 'makefile', 'GNUmakefile']) { const t = rd(f); if (t) { const names = []; for (const l of t.split('\n')) { if (!l || /^[\t #]/.test(l)) continue; const i = l.indexOf(':'); if (i < 0 || l[i + 1] === '=' || /[=$%(]/.test(l.slice(0, i))) continue; for (const n of l.slice(0, i).split(/\s+/).filter(Boolean)) if (/^[\w-][\w./-]*$/.test(n) && !names.includes(n)) names.push(n); } if (names.length) g.push({ kind: 'make', file: f, tasks: names.map((n) => ({ name: n, cmd: `make ${n}` })) }); break; } }
      for (const f of ['justfile', 'Justfile']) { const t = rd(f); if (t) { const names = []; for (const l of t.split('\n')) { if (!l || /^[\t #]/.test(l) || l.includes(':=')) continue; const i = l.indexOf(':'); if (i < 0) continue; const n = l.slice(0, i).trim().replace(/^@/, '').split(/\s+/)[0]; if (/^[\w-]+$/.test(n) && !['set', 'alias', 'export', 'import', 'mod'].includes(n) && !names.includes(n)) names.push(n); } if (names.length) g.push({ kind: 'just', file: f, tasks: names.map((n) => ({ name: n, cmd: `just ${n}` })) }); break; } }
      for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) if (ex(f)) { g.push({ kind: 'compose', file: f, tasks: ['up -d', 'down', 'logs -f', 'ps', 'build'].map((a) => ({ name: a, cmd: `docker compose ${a}` })) }); break; }
      return g;
    };
    let dir = cwd;
    for (let i = 0; i < 6; i++) { const g = detect(dir); if (g.length) return { root: dir, groups: g }; const up = path.dirname(dir); if (up === dir) break; dir = up; }
    return { root: cwd, groups: [] };
  },
  listDir: ({ path: p, hidden }) => {
    const exp = p.startsWith('~') ? os.homedir() + p.slice(1) : p; const dir = fs.realpathSync(exp);
    const ents = fs.readdirSync(dir).filter((n) => hidden || !n.startsWith('.')).map((n) => { try { const st = fs.statSync(path.join(dir, n)); return { name: n, dir: st.isDirectory(), size: st.size }; } catch { return null; } }).filter(Boolean);
    ents.sort((a, b) => (b.dir - a.dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries: ents.slice(0, 1000), truncated: ents.length > 1000 };
  },
  disks: () => new Promise((res) => execFile('df', ['-kP', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'efivarfs', '-x', 'overlay'], (err, out) => res(err && !out ? [] : out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6 && +f[1] > 0).map((f) => ({ fs: f[0], mount: f.slice(5).join(' '), used: +f[2] * 1024, total: +f[1] * 1024 }))))),
  http: async ({ req }) => {
    if (!/^https?:\/\//.test(req.url)) throw new Error('La URL debe empezar por http:// o https://');
    const t0 = Date.now(); let r;
    try { r = await fetch(req.url, { method: req.method, headers: req.headers || [], body: req.body && !['GET', 'HEAD'].includes(req.method) ? req.body : undefined, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new Error(`No se pudo completar la petición: ${e.cause?.message || e.message}`); }
    const buf = Buffer.from(await r.arrayBuffer()), MAX = 1024 * 1024;
    return { status: r.status, statusText: r.statusText, timeMs: Date.now() - t0, size: buf.length, headers: [...r.headers.entries()], truncated: buf.length > MAX, body: buf.subarray(0, MAX).toString('utf8') };
  },
  configGet: () => publicCfg(),
  configSet: ({ patch }) => { setCfg(patch); return null; },
  aiChat: ({ id, req }) => {
    const emit = (kind, text = '') => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ai', ev: { id, kind, text } }));
    streamAI(id, req, emit).then(() => emit('done')).catch((e) => emit('error', e.message)).finally(() => cancelled.delete(id));
    return null;
  },
  aiCancel: ({ id }) => { cancelled.add(id); return null; },
});

const wss = new WebSocketServer({ server, path: '/pty' });
wss.on('connection', (ws) => {
  const ptys = new Map();
  const rpc = rpcMethods(ws, ptys);
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'spawn') {
      const cwd = m.cwd && fs.existsSync(m.cwd) ? m.cwd : process.env.VEXOR_CWD || os.homedir();
      const shellPath = loadCfg().shell || process.env.SHELL || '/bin/bash';
      let shellArgs = [];
      if (path.basename(shellPath) === 'bash' && loadCfg().shellIntegration !== false) {
        const d = path.join(os.tmpdir(), 'vexor-shell'); fs.mkdirSync(d, { recursive: true });
        const integ = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'shell', 'vexor.bash'), 'utf8');
        fs.writeFileSync(path.join(d, 'vexor.bash'), integ);
        fs.writeFileSync(path.join(d, 'bashrc'), `[ -f "\${VEXOR_BASHRC:-$HOME/.bashrc}" ] && . "\${VEXOR_BASHRC:-$HOME/.bashrc}"\n. "${d}/vexor.bash"\n`);
        shellArgs = ['--rcfile', path.join(d, 'bashrc'), '-i'];
      }
      const p = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd,
        env: { ...process.env, ...utf8Env(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'vexor' },
      });
      ptys.set(m.id, p);
      p.onData((data) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'data', id: m.id, data })));
      p.onExit(() => { ptys.delete(m.id); ws.readyState === 1 && ws.send(JSON.stringify({ t: 'exit', id: m.id })); });
    } else if (m.t === 'write') ptys.get(m.id)?.write(m.data);
    else if (m.t === 'resize') { try { ptys.get(m.id)?.resize(m.cols, m.rows); } catch {} }
    else if (m.t === 'kill') { ptys.get(m.id)?.kill(); ptys.delete(m.id); }
    else if (m.t === 'rpc') {
      try { ws.send(JSON.stringify({ t: 'rpc', rid: m.rid, result: await rpc[m.method](m.args) ?? null })); }
      catch (e) { ws.send(JSON.stringify({ t: 'rpc', rid: m.rid, error: String(e.message || e) })); }
    }
  });
  ws.on('close', () => ptys.forEach((p) => p.kill()));
});
const port = process.env.PORT || 4173;
server.listen(port, '127.0.0.1', () => console.log(`Vexor (web) → http://127.0.0.1:${port}`));
