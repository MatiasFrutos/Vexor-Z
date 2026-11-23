// Capa de transporte: Tauri (IPC nativo, PTY en Rust) o WebSocket (modo navegador/dev con servidor Node).
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function createTransport() {
  const dataH = new Set(), exitH = new Set(), aiH = new Set();

  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    await listen('pty-data', (e) => dataH.forEach((h) => h(e.payload.id, e.payload.data)));
    await listen('pty-exit', (e) => exitH.forEach((h) => h(e.payload.id)));
    await listen('ai-event', (e) => aiH.forEach((h) => h(e.payload)));
    return {
      kind: 'tauri',
      spawn: (id, cols, rows, cwd) => invoke('pty_spawn', { id, cols, rows, cwd: cwd || null }),
      write: (id, data) => invoke('pty_write', { id, data }),
      resize: (id, cols, rows) => invoke('pty_resize', { id, cols, rows }),
      kill: (id) => invoke('pty_kill', { id }),
      cwd: (id) => invoke('pty_cwd', { id }).catch(() => null),
      git: (cwd) => invoke('git_info', { cwd }).catch(() => null),
      which: (names) => invoke('which_cmds', { names }).catch(() => names.map(() => false)),
      gitStatus: (cwd) => invoke('git_status', { cwd }).catch(() => null),
      sys: () => invoke('sys_stats').catch(() => null),
      disks: () => invoke('disks_list').catch(() => []),
      http: (req) => invoke('http_request', { req }),
      dockerPs: () => invoke('docker_ps'),
      dockerAction: (action, name) => invoke('docker_action', { action, name }),
      openUrl: (url) => invoke('open_url', { url }),
      fg: (id) => invoke('pty_fg', { id }).catch(() => null),
      history: (limit) => invoke('history_list', { limit }).catch(() => []),
      ps: () => invoke('ps_list').catch(() => []),
      ports: () => invoke('ports_list'),
      killProc: (pid, signal) => invoke('proc_kill', { pid, signal }),
      projectTasks: (cwd) => invoke('project_tasks', { cwd }),
      listDir: (path, hidden) => invoke('list_dir', { path, hidden: !!hidden }),
      win: {
        async size() { const { getCurrentWindow } = await import('@tauri-apps/api/window'); const w = getCurrentWindow(); const [s, f] = await Promise.all([w.innerSize(), w.scaleFactor()]); return { w: Math.round(s.width / f), h: Math.round(s.height / f) }; },
        async setSize(w, h) { const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window'); await getCurrentWindow().setSize(new LogicalSize(w, h)); },
        async onResize(cb) { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().onResized(() => cb()); },
        async setFullscreen(b) { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().setFullscreen(b); },
        async isFullscreen() { const { getCurrentWindow } = await import('@tauri-apps/api/window'); return getCurrentWindow().isFullscreen(); },
        async setAlwaysOnTop(b) { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().setAlwaysOnTop(b); },
      },
      sshHosts: () => invoke('ssh_hosts').catch(() => []),
      launchArgs: () => invoke('launch_args').catch(() => ({})),
      writeTemp: (name, text) => invoke('write_temp', { name, text }),
      notify: (title, body) => invoke('notify', { title, body }).catch(() => {}),
      newWindow: (cwd) => invoke('new_window', { cwd: cwd || null }),
      onFileDrop: async (h) => {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        await getCurrentWebview().onDragDropEvent((e) => { if (e.payload.type === 'drop') h(e.payload.paths); });
      },
      configGet: () => invoke('config_get'),
      configSet: (patch) => invoke('config_set', { patch }),
      aiChat: (id, req) => invoke('ai_chat', { id, req }),
      aiCancel: (id) => invoke('ai_cancel', { id }),
      onData: (h) => dataH.add(h), onExit: (h) => exitH.add(h), onAi: (h) => aiH.add(h),
      closeWindow: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().close(),
    };
  }

  const ws = new WebSocket(`ws://${location.host}/pty`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const pending = new Map();
  let rid = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'data') dataH.forEach((h) => h(m.id, m.data));
    else if (m.t === 'exit') exitH.forEach((h) => h(m.id));
    else if (m.t === 'ai') aiH.forEach((h) => h(m.ev));
    else if (m.t === 'rpc') { const p = pending.get(m.rid); pending.delete(m.rid); m.error ? p?.rej(new Error(m.error)) : p?.res(m.result); }
  };
  const send = (o) => ws.send(JSON.stringify(o));
  const rpc = (method, args = {}) => new Promise((res, rej) => { const r = ++rid; pending.set(r, { res, rej }); send({ t: 'rpc', rid: r, method, args }); });
  return {
    kind: 'web',
    spawn: (id, cols, rows, cwd) => send({ t: 'spawn', id, cols, rows, cwd }),
    write: (id, data) => send({ t: 'write', id, data }),
    resize: (id, cols, rows) => send({ t: 'resize', id, cols, rows }),
    kill: (id) => send({ t: 'kill', id }),
    cwd: (id) => rpc('cwd', { id }).catch(() => null),
    git: (cwd) => rpc('git', { cwd }).catch(() => null),
    which: (names) => rpc('which', { names }).catch(() => names.map(() => false)),
    gitStatus: (cwd) => rpc('gitStatus', { cwd }).catch(() => null),
    sys: () => rpc('sys').catch(() => null),
    disks: () => rpc('disks').catch(() => []),
    http: (req) => rpc('http', { req }),
    dockerPs: () => rpc('dockerPs'),
    dockerAction: (action, name) => rpc('dockerAction', { action, name }),
    openUrl: (url) => { window.open(url, '_blank', 'noopener'); return Promise.resolve(); },
    fg: (id) => rpc('fg', { id }).catch(() => null),
    history: (limit) => rpc('history', { limit }).catch(() => []),
    ps: () => rpc('ps').catch(() => []),
    ports: () => rpc('ports'),
    killProc: (pid, signal) => rpc('killProc', { pid, signal }),
    projectTasks: (cwd) => rpc('projectTasks', { cwd }),
    listDir: (path, hidden) => rpc('listDir', { path, hidden: !!hidden }),
    win: {
      size: async () => ({ w: innerWidth, h: innerHeight }),
      setSize: async () => {}, onResize: async () => {},
      setFullscreen: async (b) => { try { b ? await document.documentElement.requestFullscreen() : document.fullscreenElement && (await document.exitFullscreen()); } catch {} },
      isFullscreen: async () => !!document.fullscreenElement,
      setAlwaysOnTop: async () => {},
    },
    sshHosts: () => rpc('sshHosts').catch(() => []),
    launchArgs: () => rpc('launchArgs').catch(() => ({})),
    writeTemp: (name, text) => rpc('writeTemp', { name, text }),
    notify: (title, body) => {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
      return rpc('notify', { title, body }).catch(() => {});
    },
    newWindow: (cwd) => rpc('newWindow', { cwd }),
    onFileDrop: async (h) => {
      addEventListener('dragover', (e) => e.preventDefault());
      addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])].map((x) => x.name); if (f.length) h(f); });
    },
    configGet: () => rpc('configGet'),
    configSet: (patch) => rpc('configSet', { patch }),
    aiChat: (id, req) => rpc('aiChat', { id, req }),
    aiCancel: (id) => rpc('aiCancel', { id }),
    onData: (h) => dataH.add(h), onExit: (h) => exitH.add(h), onAi: (h) => aiH.add(h),
    closeWindow: () => window.close(),
  };
}
