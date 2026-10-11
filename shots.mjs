// 앱 화면 캡처: 각 프로젝트의 앱·거래소 화면을 찍어 shots/ 에 저장한다 (딥다이브에 보임)
//   node shots.mjs              전부 (data.json 의 app → 없으면 site)
//   node shots.mjs Derive Aevo  골라서
//   node shots.mjs --stale 6    6일보다 오래된 것만 (매주 자동 갱신용)
// 팝업·쿠키 배너·약관 창은 누르지 않고 화면에서 숨기기만 한다. 지갑 연결·로그인 없음.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'shots');
const MAN = path.join(OUT, 'index.json');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1440, H = 900, SETTLE = +(process.env.SETTLE || 9000), NAV_MAX = 25000, PAR = 3;

const slug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 화면을 가리는 것들 숨기기: 대화상자·모달·쿠키/약관 배너·반투명 배경막 + 그 뒤에 걸린 흐림
const CLEAN = `(() => {
  const W = innerWidth, H = innerHeight; let n = 0;
  const alpha = c => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return 1; const p = m[1].split(','); return p.length > 3 ? +p[3] : 1; };
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); if (!['fixed', 'absolute'].includes(cs.position) || cs.display === 'none') continue;
    const r = el.getBoundingClientRect(), z = +cs.zIndex || 0, txt = (el.innerText || '').toLowerCase().slice(0, 600);
    const dialog = el.matches('[role=dialog],[role=alertdialog],[aria-modal=true],[class*=modal i],[class*=overlay i],[class*=backdrop i],[class*=cookie i],[id*=cookie i],[class*=consent i],[id*=consent i]');
    const a = alpha(cs.backgroundColor), veil = r.width > W * .6 && r.height > H * .6 && ((a > .05 && a < .95) || cs.backdropFilter !== 'none');
    const pop = r.width > 160 && r.height > 80 && r.width < W * .85 && z >= 5 && /terms|agree|cookie|accept|welcome|don.t show|got it|dismiss|close|now live/.test(txt);
    if (cs.position === 'absolute' ? pop && z >= 10 && r.width < W * .5 : dialog || veil || pop) { el.style.setProperty('display', 'none', 'important'); n++; }
  }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.filter.includes('blur')) el.style.setProperty('filter', 'none', 'important');
    if (cs.backdropFilter.includes('blur') && cs.position !== 'fixed') el.style.setProperty('backdrop-filter', 'none', 'important');
  }
  document.documentElement.style.overflow = ''; document.body.style.overflow = '';
  scrollTo(0, 0); return n;
})()`;

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const wait = new Map(), on = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else on.forEach(f => f(m)); };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return {
    ready, close: () => ws.close(), on: f => on.push(f),
    send: (method, params = {}) => new Promise(res => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
  };
}

async function launch() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'opshnz-shots-'));
  const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((res, rej) => {
    let buf = ''; const t = setTimeout(() => rej(new Error('Chrome 시작 실패')), 20000);
    ch.stderr.on('data', d => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
  });
  return { port: new URL(ws).port, kill: async () => { ch.kill(); await new Promise(r => { ch.once('exit', r); setTimeout(r, 3000); }); try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 3 }); } catch {} } };
}

async function shoot(port, p) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const t = await r.json(); const c = cdp(t.webSocketDebuggerUrl); await c.ready;
  try {
    let loaded = false; c.on(m => { if (m.method === 'Page.loadEventFired') loaded = true; });
    await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const ua = (await c.send('Browser.getVersion')).result.userAgent.replace('HeadlessChrome', 'Chrome');
    await c.send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en' });
    await c.send('Page.navigate', { url: p.url });
    const t0 = Date.now(); while (!loaded && Date.now() - t0 < NAV_MAX) await sleep(250);
    await sleep(SETTLE);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    const hid = (await c.send('Runtime.evaluate', { expression: CLEAN, returnByValue: true })).result?.result?.value;
    await sleep(900);
    const shot = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 74, captureBeyondViewport: false });
    const buf = Buffer.from(shot.result.data, 'base64');
    if (buf.length < 25000) throw new Error(`화면이 거의 비어 있음 (${(buf.length / 1024).toFixed(0)}KB)`);
    const file = `shots/${slug(p.name)}.jpg`;
    fs.writeFileSync(path.join(DIR, file), buf);
    return { file, url: p.url, at: new Date().toISOString(), kb: Math.round(buf.length / 1024), hid };
  } finally { c.close(); fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); }
}

export async function shots({ names = [], staleDays = 0, log = console.log } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const data = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
  const man = fs.existsSync(MAN) ? JSON.parse(fs.readFileSync(MAN, 'utf8')) : {};
  const list = data.projects.filter(p => p.app || p.site).map(p => ({ name: p.name, url: p.app || p.site, core: p.core }))
    .filter(p => !names.length || names.includes(p.name))
    .filter(p => !staleDays || !man[p.name] || man[p.name].url !== p.url || Date.now() - Date.parse(man[p.name].at) > staleDays * 864e5)
    .sort((a, b) => (b.core ? 1 : 0) - (a.core ? 1 : 0));
  if (!list.length) { log('✓ 앱 화면: 새로 찍을 것 없음'); return man; }
  const br = await launch(); let ok = 0; const bad = [];
  try {
    const q = [...list];
    await Promise.all(Array.from({ length: PAR }, async () => {
      for (let p; (p = q.shift());) {
        try { man[p.name] = await shoot(br.port, p); ok++; log(`  · ${p.name} ${man[p.name].kb}KB${man[p.name].hid ? ` (가림막 ${man[p.name].hid}개 숨김)` : ''}`); }
        catch (e) { bad.push(`${p.name}: ${e.message}`); }
      }
    }));
  } finally { await br.kill(); }
  fs.writeFileSync(MAN, JSON.stringify(man, null, 2) + '\n');
  log(`✓ 앱 화면 ${ok}/${list.length}${bad.length ? ' · 실패 ' + bad.join(' / ') : ''}`);
  return man;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), i = a.indexOf('--stale');
  const staleDays = i >= 0 ? +a[i + 1] : 0, names = a.filter((x, k) => !x.startsWith("--") && (i < 0 || k !== i + 1));
  await shots({ names, staleDays });
}
