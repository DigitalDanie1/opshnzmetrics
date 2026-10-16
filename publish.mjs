// 주간 발행: 시세 수집 → 스냅샷 저장 → index.html 빌드 → 캡처 → 텔레그램 발송
//   node publish.mjs          발행 + 텔레그램 발송
//   node publish.mjs --dry    발송 없이 index.html · preview.png · preview.txt 만 만든다
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { collect, grandPrix, raceSeries, fundamentals, openInterest, venueExtras, dmMarket, macroWeek, sentiScore, sentiInputs, sentiVerdict, majorsHistory, macroTape } = require('./collect.js');
const DRY = process.argv.includes('--dry');
// --auto: 예약 실행용. 매번 빌드하고, 텔레그램은 월요일(KST)에만, 봇이 없으면 조용히 건너뛴다
const AUTO = process.argv.includes('--auto');
const isMondayKST = new Date(Date.now() + 9 * 3600e3).getUTCDay() === 1;
// 맥에선 설치된 크롬, GitHub Actions(리눅스)에선 CHROME 환경변수(/usr/bin/google-chrome)
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 비밀값: 맥은 .env, GitHub Actions 는 저장소 Secrets(환경변수) — 환경변수가 우선
const env = { ...loadEnv(path.join(DIR, '.env')), ...Object.fromEntries(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_CHANNEL', 'DASHBOARD_URL'].filter(k => process.env[k]).map(k => [k, process.env[k]])) };
const data = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
const contentPath = path.join(DIR, 'content.json');
const content = fs.existsSync(contentPath) ? JSON.parse(fs.readFileSync(contentPath, 'utf8')) : { items: [] };
const refsPath = path.join(DIR, 'refs.json');
const shotsPath = path.join(DIR, 'shots', 'index.json');
const refs = fs.existsSync(refsPath) ? JSON.parse(fs.readFileSync(refsPath, 'utf8')) : { refs: {}, farms: [] };
const found = await discover(data);

const snap = await collect(data);
if (!snap.ok.prices) fail('CoinGecko 가격을 못 받았습니다(429일 수 있음). 1분 뒤 다시 실행하세요.');
if (!snap.ok.volume) console.warn('! DefiLlama 거래량을 못 받았습니다. 거래량 칸은 비어서 나갑니다.');
snap.race = await raceSeries(snap);
snap.fund = await fundamentals(snap);
if (snap.fund) snap.fund.oi = await openInterest();
console.log(`✓ 미결제약정 ${snap.fund && snap.fund.oi ? Object.keys(snap.fund.oi.venues).join(', ') : '실패'}`);
if (snap.fund) snap.fund.ex = await venueExtras();
console.log(`✓ 거래소 부가 데이터 ${snap.fund && snap.fund.ex ? `큰 거래 ${snap.fund.ex.trades.length}건 · 변동성 지수 ${Object.keys(snap.fund.ex.vol).join(',') || '없음'}` : '실패'}`);
snap.dm = await dmMarket();
snap.macro = await macroWeek();
console.log(`✓ 매크로 일정 ${snap.macro ? snap.macro.length + '건' : '실패'}`);
snap.majorsHist = await majorsHistory();
snap.tape = await macroTape();

// 옵션 심리 일지 (sentiment.json): 자산별 하루 한 줄. 처음엔 지난 7일을 스큐만으로 채운다(partial)
{
  const p = path.join(DIR, 'sentiment.json'), log = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  const dKST = ts => new Date(ts + 9 * 3600e3).toISOString().slice(0, 10), today = dKST(Date.now()), r2 = v => v == null ? null : +(+v).toFixed(3);
  for (const [a, A] of Object.entries((snap.dm && snap.dm.assets) || {})) {
    const rows = log[a] = log[a] || [];
    const put = r => { const i = rows.findIndex(x => x.d === r.d); if (i < 0) rows.push(r); else if (rows[i].partial || !r.partial) rows[i] = r; };
    for (const [ts, rr] of (A.senti && A.senti.rrPts) || []) { const d = dKST(ts); if (d >= today || rr == null) continue; const sc = sentiScore({ rr }); put({ d, score: r2(sc.score), verdict: sc.verdict, rr: r2(rr), partial: true }); }
    const x = sentiInputs(A), sc = sentiScore(x);
    if (sc) put({ d: today, score: r2(sc.score), verdict: sc.verdict, rr: r2(x.rr), rr7: r2(x.rr7), pc: r2(x.pc), flowC: Math.round(x.flowC), flowP: Math.round(x.flowP), near: r2(x.near), spot: r2(A.spot) });
    rows.sort((u, v) => u.d.localeCompare(v.d));
  }
  fs.writeFileSync(p, JSON.stringify(log, null, 1) + '\n');
  snap.sentLog = log;
  console.log(`✓ 심리 일지 ${Object.entries(log).map(([a, r]) => `${a} ${r.length}일 · 오늘 ${(r.find(x => x.d === today) || {}).verdict || '—'}`).join(' / ')}`);
}
console.log(`✓ 시장 상태(Derivatives Monkey) ${snap.dm ? Object.keys(snap.dm.assets).join('·') + ` · 거래소 ${snap.dm.venues.length}곳` : '실패 — Strategy 의 시장 상태는 비어서 나갑니다'}`);

// 일별 기록(history.json): 미결제약정 추이 · BVIV · Derive 누적 명목(→ 하루 차이 = 24시간 기초자산별 거래량)
const histPath = path.join(DIR, 'history.json');
const hist = fs.existsSync(histPath) ? JSON.parse(fs.readFileSync(histPath, 'utf8')) : [];
const dayKST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
if (snap.fund && snap.fund.oi) {
  const prevDay = [...hist].reverse().find(h => h.d < dayKST && h.dTot);
  if (prevDay && snap.fund.ex) {
    const days = Math.max(1, (Date.now() - prevDay.ts) / 864e5), dv = {};
    for (const [c, v] of Object.entries(snap.fund.oi.dTot || {})) { const p0 = prevDay.dTot[c]; if (p0 != null && v >= p0) dv[c] = (v - p0) / days; }
    snap.fund.ex.volU.Derive = dv; snap.fund.ex.deriveSince = prevDay.d;
  }
  const entry = { d: dayKST, ts: Date.now(), oi: Object.fromEntries(Object.entries(snap.fund.oi.venues).map(([v, x]) => [v, Math.round(x.total)])), dTot: snap.fund.oi.dTot,
    bviv: snap.fund.ex && snap.fund.ex.vol.BVIV ? snap.fund.ex.vol.BVIV.px : null };
  const i = hist.findIndex(h => h.d === dayKST); if (i >= 0) hist[i] = entry; else hist.push(entry);
  fs.writeFileSync(histPath, JSON.stringify(hist.slice(-400)));
  snap.fund.oiHist = hist.map(h => ({ d: h.d, oi: h.oi, bviv: h.bviv }));
}

// 시그널: 새 프로젝트 · 포인트/상태 변경 · 친구 24시간 급변 · BVIV · 새 콘텐츠 → signals.json 에 쌓는다
const sigPath = path.join(DIR, 'signals.json'), statePath = path.join(DIR, 'state.json');
const sigLog = fs.existsSync(sigPath) ? JSON.parse(fs.readFileSync(sigPath, 'utf8')) : [];
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
// key 가 있으면 같은 날 같은 대상(BVIV·티커)은 최신 한 줄로 덮어쓴다
const sig = (kind, text, href = '', key = '') => {
  const i = sigLog.findIndex(x => x.d === dayKST && (key ? x.key === key : x.text === text));
  const row = { d: dayKST, kind, text, href, ...(key ? { key } : {}) };
  if (i >= 0) { if (key) sigLog[i] = row; } else sigLog.push(row);
};
// 예전 기록 정리: 같은 날 같은 종류(vol·move)·같은 대상은 마지막 것만
for (let i = sigLog.length - 1; i >= 0; i--) { const x = sigLog[i]; const k = x.key || (x.kind === 'vol' ? 'BVIV' : x.kind === 'move' ? x.text.split(' ')[0] : ''); if (!k) continue; x.key = k;
  if (sigLog.findIndex(y => y.d === x.d && (y.key || (y.kind === 'vol' ? 'BVIV' : y.kind === 'move' ? y.text.split(' ')[0] : '')) === k) < i) sigLog.splice(sigLog.findIndex(y => y.d === x.d && (y.key || (y.kind === 'vol' ? 'BVIV' : y.kind === 'move' ? y.text.split(' ')[0] : '')) === k), 1); }
for (const n of found) sig('new', `New options project spotted: ${n}`, `#/deep/${encodeURIComponent(n)}`);
const nowState = Object.fromEntries(snap.projects.map(p => [p.name, [p.stage, p.status || '', p.points || ''].join('|')]));
if (state) for (const p of snap.projects) {
  const was = state[p.name]; if (was === undefined) { if (p.core) sig('friend', `${p.name} joins the Friends`, `#/deep/${encodeURIComponent(p.name)}`); continue; }
  const [st0, s0, pt0] = was.split('|');
  if (st0 !== 'post' && p.stage === 'post') sig('tge', `${p.name} is live — $${p.ticker} listed`, `#/deep/${encodeURIComponent(p.name)}`);
  else if (pt0 !== (p.points || '') && p.points) sig('points', `${p.name} points: ${p.points}`, '#/overview/live');
  else if (s0 !== (p.status || '') && p.status) sig('points', `${p.name} → ${p.status}`, '#/overview/live');
}
fs.writeFileSync(statePath, JSON.stringify(nowState));
for (const p of snap.projects.filter(p => p.core && p.ch24 != null && Math.abs(p.ch24) >= 8))
  sig('move', `$${p.ticker} ${p.ch24 > 0 ? '+' : '−'}${Math.abs(p.ch24).toFixed(1)}% in 24h`, `#/deep/${encodeURIComponent(p.name)}`, '$' + p.ticker);
const bv = snap.fund && snap.fund.ex && snap.fund.ex.vol.BVIV;
if (bv && bv.prev) { const ch = (bv.px / bv.prev - 1) * 100;
  sig('vol', `BVIV ${bv.px.toFixed(1)} (${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(1)}% 24h) — BTC implied vol ${Math.abs(ch) >= 5 ? (ch > 0 ? 'spiking' : 'collapsing') : ch > 0 ? 'ticking up' : 'easing'}`, '#/deep/Volmex', 'BVIV'); }
for (const c of content.items.filter(c => c.date && Date.now() - Date.parse(c.date) < 8 * 864e5)) sig('content', `New ${c.type || 'post'}: ${c.title}`, c.url);
fs.writeFileSync(sigPath, JSON.stringify(sigLog.slice(-300), null, 1));
snap.signals = sigLog.filter(x => Date.now() - Date.parse(x.d) < 14 * 864e5).reverse();
console.log(`✓ 시그널 ${snap.signals.length}개 (최근 14일)`);
console.log(`✓ 펀더멘털 ${snap.fund ? snap.fund.venues.length + '개 거래소' : '실패'}${snap.fund && snap.fund.deribit ? ' · Deribit 비교' : ''}`);
console.log(`✓ 레이스 리플레이 거래량 ${Object.keys(snap.race.vol).length}곳 · 수익률 ${Object.keys(snap.race.ret).length}곳`);

// 로고를 폴더 안(logos/auto)에 받아 두고 그 경로를 쓴다 — 외부 이미지가 막힌 곳·호스팅에서도 항상 보이게
await localizeLogos(snap);
// 앱 화면: 6일 넘은 것만 다시 찍는다 (실패해도 빌드는 계속, 직전 화면 유지)
try { const { shots } = await import('./shots.mjs'); await shots({ staleDays: 6, log: m => console.log(m) }); } catch (e) { console.warn('! 앱 화면 캡처 실패:', e.message); }
const shotsMan = fs.existsSync(shotsPath) ? JSON.parse(fs.readFileSync(shotsPath, 'utf8')) : {};

// 스냅샷: 주마다 한 파일. 같은 주에 다시 돌리면 덮어쓴다.
const snapDir = path.join(DIR, 'snapshots');
fs.mkdirSync(snapDir, { recursive: true });
fs.writeFileSync(path.join(snapDir, `${snap.week}.json`), JSON.stringify(snap, null, 1));
const history = fs.readdirSync(snapDir).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).sort()
  .map(f => JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')))
  .map(({ race, fund, signals, dm, macro, sentLog, majorsHist, ...s }) => ({ ...s, projects: s.projects.map(({ spark, ...p }) => p) }));

// 빌드
const inline = o => JSON.stringify(o).replace(/</g, '\\u003c');
const tpl = fs.readFileSync(path.join(DIR, 'template.html'), 'utf8');
const collectSrc = fs.readFileSync(path.join(DIR, 'collect.js'), 'utf8');
const html = must(tpl, '/*__COLLECT__*/').replace('/*__COLLECT__*/', () => collectSrc)
  .replace('/*__DATA__*/null', () => inline({ snapshot: snap, history, config: data, content, refs, shots: shotsMan }));
must(html, '"snapshot"');
const out = path.join(DIR, 'index.html');
fs.writeFileSync(out, html);
console.log('✓ 빌드', out);

// 캡처 두 장: 생태계 지도만(크게) + 전체. DOM 을 덤프해 높이를 잰 뒤 그 높이로 찍는다
const base = ['--headless=new', '--hide-scrollbars', '--force-device-scale-factor=2', '--virtual-time-budget=6000', ...(process.env.CI ? ['--no-sandbox'] : [])];
function shoot(hash, png) {
  const url = 'file://' + out + hash;
  const dom = execFileSync(CHROME, [...base, '--window-size=1080,1600', '--dump-dom', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const h = Math.min(4800, +(dom.match(/data-h="(\d+)"/) || [])[1] || 2400);
  execFileSync(CHROME, [...base, `--window-size=1080,${h}`, `--screenshot=${png}`, url], { stdio: 'ignore' });
  console.log('✓ 캡처', path.basename(png), `1080×${h}`);
  return png;
}
try { (await import('./og.mjs')).makeOg(); } catch (e) { console.warn('! 공유 이미지 실패:', e.message); }
const pngMap = shoot('#tgmap', path.join(DIR, 'preview-map.png'));
const png = shoot('#tg', path.join(DIR, 'preview.png'));
// 공유용 카드(1200×675, X 에 바로 올리는 크기): 시상대 · 이번 주 상승/하락 · 시그널
const shareDir = path.join(DIR, 'share'); fs.mkdirSync(shareDir, { recursive: true });
const shares = {};
for (const k of ['podium', 'movers', 'signals']) {
  const f = path.join(shareDir, `${snap.week}-${k}.png`);
  execFileSync(CHROME, [...base, '--window-size=1200,675', `--screenshot=${f}`, 'file://' + out + '#share/' + k], { stdio: 'ignore' });
  shares[k] = f;
}
console.log('✓ 공유 카드', Object.keys(shares).join(' · '), '→ share/');

const text = digest(snap, data);
fs.writeFileSync(path.join(DIR, 'preview.txt'), text);

if (DRY) { console.log('\n--dry: 발송 안 함\n\n' + text.replace(/<[^>]+>/g, '')); process.exit(0); }
if (AUTO && !isMondayKST) { console.log('auto: 빌드만 (텔레그램은 월요일)'); process.exit(0); }
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { if (AUTO) { console.log('auto: 봇 미연결 — 빌드만'); process.exit(0); } fail('.env 에 봇이 없습니다. 먼저: node setup-bot.mjs <봇토큰>'); }

const caption = `<b>Korean Opshnz · ${snap.week}</b>` + (snap.headline ? `\n${esc(snap.headline)}` : '');
await tg('sendMediaGroup', { chat_id: env.TELEGRAM_CHAT_ID, media: JSON.stringify([
  { type: 'photo', media: 'attach://map', caption, parse_mode: 'HTML' },
  { type: 'photo', media: 'attach://full' },
]) }, { map: pngMap, full: png });
await tg('sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
await tg('sendMediaGroup', { chat_id: env.TELEGRAM_CHAT_ID, media: JSON.stringify([
  { type: 'photo', media: 'attach://podium', caption: 'Share cards for X — this week', parse_mode: 'HTML' }, { type: 'photo', media: 'attach://movers' }, { type: 'photo', media: 'attach://signals' },
]) }, shares);
console.log('✓ 텔레그램 발송 완료');
// 공개 채널(.env TELEGRAM_CHANNEL=@이름): 봇이 채널 관리자여야 한다
if (env.TELEGRAM_CHANNEL) {
  const pub = publicDigest(snap);
  await tg('sendMediaGroup', { chat_id: env.TELEGRAM_CHANNEL, media: JSON.stringify([
    { type: 'photo', media: 'attach://podium', caption: pub, parse_mode: 'HTML' }, { type: 'photo', media: 'attach://movers' }, { type: 'photo', media: 'attach://signals' },
  ]) }, shares);
  console.log('✓ 공개 채널 발송', env.TELEGRAM_CHANNEL);
}

// 공개 채널용 짧은 글 (사진 캡션 1024자 안)
// 옵션 심리 요약 (텔레그램용): 오늘 + 지난 7일 평균
function sentiLines(s) {
  const out = [];
  for (const a of ['BTC', 'ETH']) {
    const r = ((s.sentLog || {})[a] || []).slice(-7); if (!r.length) continue;
    const t = r[r.length - 1], avg = r.reduce((x, y) => x + y.score, 0) / r.length, sg = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
    out.push(`${a}: today <b>${t.verdict.toLowerCase()}</b> (${sg(t.score)}) · 7-day ${sentiVerdict(avg).toLowerCase()} (${sg(avg)})`);
  }
  return out.length ? ['<b>Options sentiment</b>  (bear −1 … +1 bull)', ...out] : [];
}

function publicDigest(s) {
  const gp = grandPrix(s.projects.filter(p => p.core)).table.filter(t => t.starts).slice(0, 3);
  const L = [`<b>Korean Opshnz · ${s.week}</b>`];
  if (s.headline) L.push(esc(s.headline));
  const sl = sentiLines(s); if (sl.length) L.push('', ...sl);
  if (gp.length) L.push('', '<b>Grand Prix podium</b>', gp.map((t, i) => `${['🥇', '🥈', '🥉'][i]} ${esc(t.name)} ${t.pts} pts`).join('\n'));
  const sg = (s.signals || []).slice(0, 4);
  if (sg.length) L.push('', '<b>Signals</b>', sg.map(x => `• ${esc(x.text)}`).join('\n'));
  if (env.DASHBOARD_URL) L.push('', `<a href="${esc(env.DASHBOARD_URL)}">Open the dashboard →</a>`);
  return L.join('\n').slice(0, 1020);
}

// ── 텔레그램 본문 ────────────────────────────────────────────
function digest(s, cfg) {
  // 텔레그램은 고객사만 숫자로 (대시보드는 숫자를 숨기지만 이건 나만 보는 채널)
  const post = s.projects.filter(p => p.core && p.stage === 'post').sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  const pre = s.projects.filter(p => p.core && p.stage !== 'post');
  const L = [];
  L.push(`<b>Korean Opshnz · ${s.week}</b>`);
  if (s.headline) L.push(esc(s.headline));
  L.push('');
  const sl = sentiLines(s); if (sl.length) L.push(...sl, '');
  L.push('<b>Friends · listed</b>  (7d · mcap · 30d options vol)');
  const rows = post.map(p => [ '$' + p.ticker, pctT(p.ch7), usdT(p.mcap), p.vol30 != null ? usdT(p.vol30) : '—' ]);
  const w = [0, 1, 2, 3].map(i => Math.max(...rows.map(r => r[i].length)));
  L.push('<pre>' + rows.map(r => r.map((c, i) => i ? c.padStart(w[i]) : c.padEnd(w[i])).join('  ')).join('\n') + '</pre>', '');

  const notes = s.projects.filter(p => p.note);
  if (notes.length) {
    L.push('<b>This week</b>');
    for (const p of notes) L.push(`• <b>${esc(p.ticker ? '$' + p.ticker : p.name)}</b> ${esc(p.note)}`);
    L.push('');
  }

  const gp = grandPrix(s.projects.filter(p => p.core)).table.filter(t => t.starts);
  if (gp.length) {
    L.push('<b>Friends Grand Prix</b>  (7 fundamentals races, F1 points)');
    L.push(gp.slice(0, 5).map((t, i) => `${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'} ${esc(t.name)} ${t.pts} pts${t.wins ? ` · ${t.wins}W` : ''}`).join('\n'), '');
  }

  const R = s.market.ranking.slice(0, 6);
  if (R.length) {
    L.push(`<b>30d onchain options volume</b>  total ${usdT(s.market.total30)}`);
    for (const [i, r] of R.entries()) {
      const share = s.market.total30 ? Math.round(r.vol30 / s.market.total30 * 100) : 0;
      L.push(`${i + 1}. ${esc(r.name)} ${usdT(r.vol30)} (${share}%)${r.core ? ' ★' : ''}`);
    }
    L.push('');
  }

  if (pre.length) {
    L.push('<b>Friends · pre-TGE</b>');
    for (const p of pre) {
      const bits = [p.status, p.vol30 != null && `30d vol ${usdT(p.vol30)}`, p.points].filter(Boolean);
      L.push(`• <b>${esc(p.name)}</b> ${esc(bits.join(' · '))}${p.x ? ` · <a href="https://x.com/${esc(p.x)}">@${esc(p.x)}</a>` : ''}`);
    }
  }
  const fresh = content.items.filter(c => c.date && Date.now() - Date.parse(c.date) < 8 * 864e5);
  if (fresh.length) {
    L.push('', '<b>New content</b>');
    for (const c of fresh) L.push(`• <a href="${esc(c.url)}">${esc(c.title)}</a>${c.source ? ' · ' + esc(c.source) : ''}`);
  }
  const sg = (s.signals || []).filter(x => x.d >= new Date(Date.now() - 7 * 864e5 + 9 * 3600e3).toISOString().slice(0, 10)).slice(0, 8);
  if (sg.length) L.push('', '<b>Signals</b>', ...sg.map(x => `• ${esc(x.text)}`));
  if (found.length) L.push('', `<b>New options projects found</b> ${esc(found.join(', '))} — added to data.json (check description & keywords)`);
  if (env.DASHBOARD_URL) L.push('', `<a href="${esc(env.DASHBOARD_URL)}">Open dashboard</a>`);
  return L.join('\n').trim();
}

// ── 새 옵션 프로젝트 자동 발견 ─────────────────────────────────
// DefiLlama 옵션 카테고리 + 옵션 거래량 목록에서 살아 있는(TVL ≥ $10K 또는 거래량 있음) 곳 중
// data.json 에 없는 것을 뒤에 붙인다. 설명은 영어 원문이라 auto:true 로 표시해 둔다.
// 자동 추가 설명: 첫 문장(최대 120자), 길면 단어 경계에서 자르고 …
function shortWhat(t) {
  t = String(t).replace(/\s+/g, ' ').trim();
  const first = (t.match(/^.+?[.!?](\s|$)/) || [t])[0].trim();
  if (first.length <= 120) return first.replace(/[.]$/, '');
  return first.slice(0, 118).replace(/\s+\S*$/, '') + '…';
}
async function discover(cfg) {
  const get = u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
  const [protos, opt, lite] = await Promise.all([
    get('https://api.llama.fi/protocols'),
    get('https://api.llama.fi/overview/options?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyNotionalVolume'),
    get('https://api.llama.fi/lite/protocols2'),
  ]);
  if (!protos || !opt) { console.warn('! 새 프로젝트 찾기 건너뜀 (DefiLlama 응답 없음)'); return []; }
  const vol = Object.fromEntries(opt.protocols.map(p => [p.slug, p]));
  const parents = Object.fromEntries(((lite && lite.parentProtocols) || []).map(p => [p.id, p]));
  const known = new Set(cfg.projects.flatMap(p => p.llama || []));
  const ignore = new Set(cfg.ignore || []);
  const G = {};
  for (const p of protos) {
    if (!(/^Options/.test(p.category) || vol[p.slug]) || p.deadUrl || p.rugged) continue;
    const k = p.parentProtocol || p.slug;
    const g = G[k] || (G[k] = { k, tvl: 0, v30: 0, m: [] });
    g.tvl += p.tvl || 0; g.v30 += (vol[p.slug] || {}).total30d || 0; g.m.push(p);
  }
  const HOME = { 'Hyperliquid L1': 'Hyperliquid', Base: 'Base', Arbitrum: 'Arbitrum', Ethereum: 'Ethereum', Solana: 'Solana' };
  const added = [];
  for (const g of Object.values(G)) {
    if (g.tvl < 1e4 && !g.v30) continue;
    if (known.has(g.k) || ignore.has(g.k) || g.m.some(m => known.has(m.slug) || ignore.has(m.slug))) continue;
    const par = parents[g.k] || {}, m = g.m.sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0];
    const name = (par.name || m.name).replace(/\s+(V\d+|Options|Protocol|Finance)$/i, '');
    if (cfg.projects.some(p => p.name === name) || ignore.has(name)) continue;   // 지운 프로젝트는 다시 넣지 않는다
    const cg = par.gecko_id || g.m.map(x => x.gecko_id).find(Boolean) || '';
    cfg.projects.push({
      ticker: '', name, stage: cg ? 'post' : 'pre', core: false, lineage: '', origin: '',
      home: HOME[(m.chains || [])[0]] || 'Other', what: shortWhat(par.description || m.description || ''),
      cg, llama: [g.k], site: par.url || m.url || '', x: par.twitter || m.twitter || '', keywords: [], note: '', auto: true,
    });
    added.push(name);
  }
  if (added.length) {
    fs.writeFileSync(path.join(DIR, 'data.json'), JSON.stringify(cfg, null, 2) + '\n');
    console.log('✓ 새 옵션 프로젝트', added.join(', '));
  }
  return added;
}

// ── 로고 로컬 저장 ──────────────────────────────────────────
async function localizeLogos(s) {
  const dir = path.join(DIR, 'logos', 'auto'); fs.mkdirSync(dir, { recursive: true });
  const crypto = await import('node:crypto');
  const map = {};
  const urls = new Set([...s.projects.map(p => p.logo), ...s.market.ranking.map(r => r.logo), ...((s.fund && s.fund.venues) || []).map(v => v.logo)].filter(u => u && /^https?:/.test(u)));
  let got = 0, kept = 0, failed = 0;
  for (const u of urls) {
    const id = crypto.createHash('sha1').update(u).digest('hex').slice(0, 12);
    const hit = fs.readdirSync(dir).find(f => f.startsWith(id + '.'));
    if (hit) { map[u] = `logos/auto/${hit}`; kept++; continue; }
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error(r.status);
      const ct = r.headers.get('content-type') || '', ext = /png/.test(ct) ? 'png' : /webp/.test(ct) ? 'webp' : /svg/.test(ct) ? 'svg' : /gif/.test(ct) ? 'gif' : 'jpg';
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) throw new Error('empty');
      fs.writeFileSync(path.join(dir, `${id}.${ext}`), buf); map[u] = `logos/auto/${id}.${ext}`; got++;
    } catch { failed++; }
  }
  const sw = o => { if (o && map[o.logo]) o.logo = map[o.logo]; };
  s.projects.forEach(sw); s.market.ranking.forEach(sw); ((s.fund && s.fund.venues) || []).forEach(sw);
  console.log(`✓ 로고 로컬 ${got} 새로 · ${kept} 보관 · ${failed} 실패`);
}

// ── 도우미 ──────────────────────────────────────────────────
function usdT(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}
function pctT(v) { return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%'; }
function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function must(s, needle) { if (!s.includes(needle)) fail(`빌드 실패: "${needle}" 를 찾지 못함`); return s; }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
function loadEnv(p) {
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n').filter(l => /^\w+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
}
async function tg(method, params, files) {
  const body = new FormData();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  for (const [name, f] of Object.entries(files || {})) body.append(name, new Blob([fs.readFileSync(f)], { type: 'image/png' }), name + '.png');
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', body });
  const j = await r.json();
  if (!j.ok) fail(`텔레그램 ${method} 실패: ${j.description}`);
  return j.result;
}
