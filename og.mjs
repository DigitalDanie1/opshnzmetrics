// X·텔레그램 등에 링크를 붙였을 때 뜨는 대표 이미지(1200×630)를 오늘 데이터로 만든다 → og.png
//   node og.mjs        (publish.mjs 가 매일 자동으로 부른다)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function makeOg(log = console.log) {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
  const snaps = fs.readdirSync(path.join(DIR, 'snapshots')).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).sort();
  const snap = JSON.parse(fs.readFileSync(path.join(DIR, 'snapshots', snaps.at(-1)), 'utf8'));
  const sentiFile = path.join(DIR, 'sentiment.json');
  const senti = fs.existsSync(sentiFile) ? JSON.parse(fs.readFileSync(sentiFile, 'utf8')) : [];
  const last = ((Array.isArray(senti) ? senti : senti.BTC) || []).at(-1) || {};
  const P = snap.projects, XY = data.ecoMap || {};
  const vol = P.reduce((a, p) => a + (p.vol30 || 0), 0);
  const usd = v => v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : '$' + Math.round(v / 1e6) + 'M';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const file = f => 'file://' + path.join(DIR, f);
  // 오른쪽 지도: 사분면 + 로고 (Friends 는 금색 테두리)
  const W = 548, H = 560, cx = W / 2, cy = H / 2, s = W / 13.4;
  const dots = P.filter(p => XY[p.name] && p.logo).map(p => {
    const m = Math.max(p.vol30 || 0, (p.tvl || 0) * 3), r = m > 0 ? Math.max(14, Math.min(34, (Math.log10(m) - 4) * 4.6)) : 14;
    return { p, x: cx + XY[p.name][0] * s, y: cy - XY[p.name][1] * s, r };
  }).sort((a, b) => a.r - b.r);
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>${dots.map((d, i) => `<clipPath id="c${i}"><circle cx="${d.x}" cy="${d.y}" r="${d.r - 1.5}"/></clipPath>`).join('')}</defs>
    <line x1="10" x2="${W - 10}" y1="${cy}" y2="${cy}" stroke="rgba(236,231,220,.35)"/><line y1="10" y2="${H - 10}" x1="${cx}" x2="${cx}" stroke="rgba(236,231,220,.35)"/>
    <circle cx="${cx}" cy="${cy}" r="3.5" fill="#f2b544"/>
    <text x="${W - 12}" y="${cy - 8}" text-anchor="end" class="ax">PRO →</text><text x="12" y="${cy - 8}" class="ax">← SIMPLE</text>
    <text x="${cx + 8}" y="22" class="ax">↑ TRADE</text><text x="${cx + 8}" y="${H - 10}" class="ax">↓ EARN</text>
    ${dots.map((d, i) => `${d.p.core ? `<circle cx="${d.x}" cy="${d.y}" r="${d.r + 5}" fill="rgba(242,181,68,.18)"/>` : ''}<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="#1b1a14"/>
      <image href="${esc(file(d.p.logo))}" x="${d.x - d.r + 1.5}" y="${d.y - d.r + 1.5}" width="${2 * d.r - 3}" height="${2 * d.r - 3}" clip-path="url(#c${i})" preserveAspectRatio="xMidYMid slice"/>
      <circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="none" stroke="${d.p.core ? '#f2b544' : 'rgba(236,231,220,.45)'}" stroke-width="${d.p.core ? 2 : 1.2}"${d.p.stage !== 'post' ? ' stroke-dasharray="3 2.5"' : ''}/>`).join('')}
  </svg>`;
  const verdict = last.verdict || '';
  const vcol = /BEAR/.test(verdict) ? '#ff8077' : /BULL/.test(verdict) ? '#72dc8f' : '#ece7dc';
  const day = new Date((last.d || new Date().toISOString().slice(0, 10)) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1200px;height:630px;overflow:hidden;background:#0a0b09}
body{position:relative;font-family:"Syne",system-ui,sans-serif;color:#ece7dc}
.bg{position:absolute;inset:0;background:url("${file('assets/greek-bg.webp')}") center 25%/cover;filter:grayscale(1) sepia(.5) brightness(.55);opacity:.22}
.vg{position:absolute;inset:0;background:radial-gradient(70% 90% at 78% 50%,rgba(242,181,68,.10),transparent 60%),linear-gradient(90deg,#0a0b09 0%,rgba(10,11,9,.82) 46%,rgba(10,11,9,.55) 100%)}
.fr{position:absolute;inset:14px;border:1px solid rgba(242,181,68,.28);border-radius:6px}
.l{position:absolute;left:58px;top:50px;bottom:46px;width:560px;display:flex;flex-direction:column;justify-content:space-between}
.brand{display:flex;align-items:center;gap:22px}
.mark{width:112px;height:112px;border-radius:26px;box-shadow:0 0 0 1px rgba(242,181,68,.35),0 14px 44px rgba(242,181,68,.2)}
h1{font-size:86px;line-height:.9;font-weight:700;letter-spacing:-.01em}
.k{font-size:15px;letter-spacing:.2em;color:#f2b544;font-weight:600;margin-top:10px}
h2{font-size:32px;font-weight:500;line-height:1.22;color:#ece7dc}
h2 em{font-style:italic;color:#f2b544}
.st{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.st div{padding:12px 16px;border:1px solid rgba(236,231,220,.14);border-radius:14px;background:rgba(10,11,9,.55)}
.st div small{display:block;font-size:12px;letter-spacing:.12em;color:#8f8b80;font-weight:600;white-space:nowrap}
.st div b{display:block;font-size:34px;font-weight:600;line-height:1.15;margin-top:2px;white-space:nowrap}
.st div:nth-child(4) b{font-size:25px;line-height:1.55}
.ft{display:flex;align-items:center;gap:16px}
.ft .av{width:62px;height:62px;border-radius:50%;border:2px solid #f2b544;object-fit:cover}
.ft small{display:block;font-size:12px;letter-spacing:.16em;color:#8f8b80;font-weight:600}
.ft b{display:block;font-size:23px;font-weight:600;color:#ece7dc;line-height:1.2}
.ft span{display:block;font-size:15px;color:#bdb8ab}
.ft i{width:1px;height:48px;background:rgba(236,231,220,.2);margin:0 8px}
.ft .site b{font-size:22px;color:#f2b544}
.r{position:absolute;right:26px;top:35px}
.ax{fill:#bdb8ab;font-size:13px;font-weight:600;letter-spacing:.1em;font-family:"Syne",sans-serif}
</style></head><body><div class="bg"></div><div class="vg"></div><div class="fr"></div>
<div class="l">
  <div class="brand"><img class="mark" src="${file('apple-touch-icon.png')}" alt=""><div><h1>OPSHNZ</h1><div class="k">ONCHAIN OPTIONS ECOSYSTEM</div></div></div>
  <h2>Every onchain options protocol, <em>mapped</em> — and what the market thinks today.</h2>
  <div class="st"><div><small>PROJECTS</small><b>${P.length}</b></div><div><small>FRIENDS</small><b>${P.filter(p => p.core).length}</b></div><div><small>30D ONCHAIN VOLUME</small><b>${usd(vol)}</b></div>${verdict ? `<div><small>BTC OPTIONS · ${esc(day.replace(/, \d{4}$/, ''))}</small><b style="color:${vcol}">${esc(verdict)}</b></div>` : ''}</div>
  <div class="ft"><img class="av" src="${file('assets/creator.jpg')}" alt=""><div><small>MADE BY</small><b>defi_daniel</b><span>@0xdefidaniel</span></div><i></i><div class="site"><b>opshnz.com</b><span>free · updated daily</span></div></div>
</div>
<div class="r">${svg}</div>

</body></html>`;
  const tmp = path.join(DIR, 'og-card.html');
  fs.writeFileSync(tmp, html);
  const out = path.join(DIR, 'og.png');
  const prof = fs.mkdtempSync(path.join((process.env.TMPDIR || '/tmp'), 'opshnz-og-'));
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${prof}`, '--window-size=1200,630', '--virtual-time-budget=8000', ...(process.env.CI ? ['--no-sandbox'] : []), `--screenshot=${out}`, 'file://' + tmp], { stdio: 'ignore' });
  fs.rmSync(prof, { recursive: true, force: true });
  log(`✓ 공유 이미지 og.png (${P.length} projects · ${usd(vol)} · ${verdict || 'no verdict'})`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) makeOg();
