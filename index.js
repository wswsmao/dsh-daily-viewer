import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const name = 'dsh-daily-viewer';
export const inject = ['tools'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// Decode then reject traversal, backslash and NUL before touching the filesystem.
function safePath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(String(urlPath || '/')); } catch { return null; }
  const clean = decoded.split('?')[0].split('#')[0];
  if (clean.includes('\0') || clean.includes('\\')) return null;
  return clean;
}

async function resolveFile(rootDir, clean) {
  const rel = clean.replace(/^\/+/, '') || 'index.html';
  const abs = path.resolve(rootDir, rel);
  const rootResolved = path.resolve(rootDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  let st;
  try { st = await fs.lstat(abs); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  if (st.isDirectory()) {
    const idx = path.join(abs, 'index.html');
    try { const s2 = await fs.lstat(idx); if (s2.isFile() && !s2.isSymbolicLink()) return idx; } catch { /* no index */ }
    return null;
  }
  return st.isFile() ? abs : null;
}

function headers(type) {
  return {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The page loads only same-origin assets; no inline or eval script anywhere.
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
  };
}

export function apply(ctx, config = {}) {
  const siteDir = String(config.site_dir || 'D:\\Program Files (x86)\\dsh-deploy\\archive\\daily\\ai-tech-daily\\site');
  const requestedPort = Number.isSafeInteger(config.port) ? config.port : 8731;
  const host = '127.0.0.1'; // loopback only: never reachable from another machine

  let server = null;
  let actualPort = requestedPort;

  const handler = async (req, res) => {
    try {
      const clean = safePath(req.url);
      if (clean === null) { res.writeHead(400, headers('text/plain; charset=utf-8')); res.end('bad request'); return; }
      const file = await resolveFile(siteDir, clean);
      if (!file) { res.writeHead(404, headers('text/plain; charset=utf-8')); res.end('not found'); return; }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, headers(type));
      createReadStream(file).on('error', () => { try { res.destroy(); } catch { /* gone */ } }).pipe(res);
    } catch {
      try { res.writeHead(500, headers('text/plain; charset=utf-8')); res.end('server error'); } catch { /* gone */ }
    }
  };

  server = createServer(handler);

  // If the preferred port is taken, walk a small range instead of failing to start.
  const listen = (port, left) => new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err && err.code === 'EADDRINUSE' && left > 0) {
        server.removeListener('error', onError);
        listen(port + 1, left - 1).then(resolve, reject);
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => { server.removeListener('error', onError); resolve(port); });
  });

  const ready = listen(requestedPort, 12).then((port) => { actualPort = port; return port; });
  ready.then((p) => { ctx.logger?.info?.(`daily viewer ready: http://127.0.0.1:${p}/`); })
    .catch((e) => { ctx.logger?.warn?.(`daily viewer failed to listen: ${e?.message ?? e}`); });

  const dispose = ctx.effect(() => () => {
    if (server) { try { server.close(); } catch { /* already closed */ } server = null; }
  });

  ctx.tools.register({
    name: 'daily_viewer_open',
    description: '打开本地 AI 日报归档浏览页面（仅本机 127.0.0.1 可访问），返回链接与归档列表。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: '打开日报归档', kind: 'read' }),
    execute: async () => {
      const port = await ready;
      let editions = [];
      try {
        const entries = await fs.readdir(path.join(siteDir, 'reports'), { withFileTypes: true });
        editions = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      } catch { /* no reports yet */ }
      return { url: `http://127.0.0.1:${port}/`, archive_url: `http://127.0.0.1:${port}/archive.html`, editions };
    },
  });

  return dispose;
}
