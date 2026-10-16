// 나만 쓰는 편집기:  node editor.mjs  →  http://localhost:4848
// - 127.0.0.1 에만 열린다 (같은 Mac 밖에서는 접속 불가)
// - 켤 때마다 새 열쇠를 만들어 이 서버가 내주는 페이지에만 심는다 → 다른 사이트가 몰래 저장 요청을 보낼 수 없다
// - 저장하면 data.json 에 쓰고 index.html 을 바로 다시 만든다. 공개 사이트에는 편집 버튼이 없다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rebuild } from './rebuild.mjs';
import { execFile } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 4848);
const KEY = crypto.randomBytes(18).toString('hex');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpeg': 'image/jpeg' };

rebuild();

// 저장한 글을 GitHub 저장소에도 올린다(저장소가 연결돼 있을 때만). 매일 빌드는 GitHub Actions 가 한다
function pushToGitHub(msg) {
  if (!fs.existsSync(path.join(DIR, '.git'))) return;
  const sh = cmd => new Promise((res, rej) => execFile('/bin/zsh', ['-lc', cmd], { cwd: DIR }, (e, out, err) => e ? rej(new Error(err || e.message)) : res(out)));
  sh(`git add data.json index.html && (git diff --cached --quiet || git commit -m ${JSON.stringify(msg)}) && git pull --rebase --autostash && git push`)
    .then(() => console.log('  ↑ GitHub 에 올림'))
    .catch(e => console.log('  ! GitHub 업로드 실패 — 나중에 다시 저장하면 재시도:', e.message.split('\n')[0]));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    if (req.headers['x-editor-key'] !== KEY) { res.writeHead(403).end('forbidden'); return; }
    if (url.pathname === '/api/ping') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
    if (url.pathname === '/api/project' && req.method === 'POST') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 2e5) { res.writeHead(413).end(); return; } }
      try {
        const { name, fields } = JSON.parse(body);
        const file = path.join(DIR, 'data.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const p = data.projects.find(x => x.name === name);
        if (!p) throw new Error('no such project: ' + name);
        const str = v => String(v ?? '').trim();
        const lines = v => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(x => String(x).trim()).filter(Boolean);
        p.note = str(fields.note);
        if ('points' in fields) { const v = str(fields.points); if (v) p.points = v; else delete p.points; }
        p.deep = {
          ...(p.deep || {}),
          writeup: str(fields.writeup),
          thesis: str(fields.thesis),
          catalysts: lines(fields.catalysts),
          risks: lines(fields.risks),
          timeline: lines(fields.timeline).map(l => { const m = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(l); return m ? { date: m[1], text: m[2] } : null; }).filter(Boolean),
          updated: new Date().toISOString(),
        };
        fs.writeFileSync(file + '.bak', fs.readFileSync(file));   // 직전 1개만 백업
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
        rebuild();
        console.log(`✓ 저장 ${name} · ${new Date().toLocaleTimeString()}`);
        pushToGitHub(`notes: ${name}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, project: p }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    if (url.pathname === '/api/take' && req.method === 'POST') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 1e5) { res.writeHead(413).end(); return; } }
      try {
        const { action, entry = {} } = JSON.parse(body);
        const file = path.join(DIR, 'data.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = data.myTake = data.myTake || [];
        const str = (v, n) => String(v ?? '').trim().slice(0, n);
        let label = '';
        if (action === 'delete') {
          const i = list.findIndex(x => x.id === entry.id); if (i < 0) throw new Error('no such take');
          label = list[i].title; list.splice(i, 1);
        } else {
          const t = {
            id: action === 'update' && entry.id ? str(entry.id, 40) : Date.now().toString(36),
            date: /^\d{4}-\d{2}-\d{2}$/.test(entry.date || '') ? entry.date : new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10),
            title: str(entry.title, 140), body: str(entry.body, 8000),
            stance: ['bull', 'bear', 'neutral', 'watch'].includes(entry.stance) ? entry.stance : '',
            assets: (Array.isArray(entry.assets) ? entry.assets : []).map(a => str(a, 12).toUpperCase().replace(/[^A-Z0-9.$-]/g, '')).filter(Boolean).slice(0, 6),
            at: new Date().toISOString(),
          };
          if (!t.title) throw new Error('title is required');
          const i = list.findIndex(x => x.id === t.id);
          if (action === 'update' && i < 0) throw new Error('no such take');
          if (i >= 0) list[i] = t; else list.unshift(t);
          label = t.title;
        }
        list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.at || '').localeCompare(a.at || ''));
        fs.writeFileSync(file + '.bak', fs.readFileSync(file));   // 직전 1개만 백업
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
        rebuild();
        console.log(`✓ my take ${action} · ${label}`);
        pushToGitHub(`my take: ${action} — ${label.slice(0, 60)}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, myTake: list }));
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    res.writeHead(404).end(); return;
  }
  // 정적 파일 (폴더 밖으로 못 나가게)
  let f = path.normalize(path.join(DIR, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!f.startsWith(DIR) || /\.(env|bak)$|\/\.env/.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end('not found'); return; }
  let buf = fs.readFileSync(f);
  if (f.endsWith('index.html')) buf = Buffer.from(buf.toString().replace('<head>', `<head>\n<meta name="opshnz-editor" content="${KEY}">`));
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(buf);
});
server.listen(PORT, '127.0.0.1', () => console.log(`✎ 편집기 → http://localhost:${PORT}  (Ctrl+C 로 종료)`));
