// Servidor SIMULADO compatible con OpenAI (streaming). Solo para probar la interfaz sin API real.
require('http').createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const sys = body.messages[0].content, last = body.messages[body.messages.length - 1].content;
    let text;
    if (sys.includes('generador de comandos')) text = '```bash\nfind . -size +100M\n```';
    else if (last.includes('<terminal>')) text = 'El comando falló porque `cargo` no encontró el paquete **vexor-core**.\n\n```bash\ncargo add vexor-core\n```\n\n- Revisa `Cargo.toml`.\n- Verifica la conexión.';
    else text = 'Para comprimir la carpeta actual:\n\n```bash\ntar -czf backup.tar.gz .\n```';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const parts = text.match(/.{1,12}/gs); let i = 0;
    const t = setInterval(() => {
      if (i >= parts.length) { res.write('data: [DONE]\n\n'); clearInterval(t); return res.end(); }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n');
    }, 8);
  });
}).listen(process.env.MOCK_AI_PORT || 11500, '127.0.0.1');
