// 노드(publish.mjs)와 브라우저(대시보드 새로고침) 양쪽에서 같은 코드로 시장 데이터를 모은다.
// 의존성 없음 — fetch 만 쓴다. 빌드 때 이 파일 전체가 대시보드 HTML 안으로 인라인된다.

const CG = 'https://api.coingecko.com/api/v3/coins/markets';
const LLAMA_OPT = 'https://api.llama.fi/overview/options?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyNotionalVolume';
const LLAMA_PREM = 'https://api.llama.fi/overview/options?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyPremiumVolume';
const LLAMA_PROTOCOLS = 'https://api.llama.fi/protocols';   // 2.4MB(gzip). TVL·로고. 브라우저 새로고침에선 생략

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) throw new Error('429');
      if (!r.ok) return null;
      const t = await r.text();
      try { return JSON.parse(t); } catch { return null; }
    } catch (e) {
      if (i === tries - 1) return null;
      await new Promise(res => setTimeout(res, 1500 * 2 ** i));
    }
  }
  return null;
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

// "Derive V3 Options" → "Derive", "Rysk V12" → "Rysk"
const cleanName = n => n.replace(/\s+(V\d+(\.\d+)?|Options|Protocol|Finance)\b/gi, '').trim();

// opts.prev: 브라우저 새로고침 때 직전 스냅샷 — 무거운 protocols 대신 TVL·로고를 거기서 이어받는다
async function collect(data, now = new Date(), opts = {}) {
  // 기초자산(시그널 띠 가격용)도 함께
  const MAJORS = [['bitcoin', 'BTC'], ['ethereum', 'ETH'], ['hyperliquid', 'HYPE'], ['solana', 'SOL']];
  const ids = [...new Set([...data.projects.map(p => p.cg).filter(Boolean), ...(data.benchmark?.entrants || []).map(p => p.cg).filter(Boolean), ...MAJORS.map(m => m[0])])];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const [cgParts, opt, prem, protos, financials] = await Promise.all([
    Promise.all(chunks.map(c => getJSON(`${CG}?vs_currency=usd&ids=${c.join(',')}&sparkline=true&price_change_percentage=7d,30d`))),
    getJSON(LLAMA_OPT),
    getJSON(LLAMA_PREM),
    opts.prev ? Promise.resolve(null) : getJSON(LLAMA_PROTOCOLS),
    benchmarkFinancials(data),
  ]);
  // 누적 명목 거래량(cumVolApi) — 프로젝트가 직접 공개하는 API. 동기 map 전에 병렬로 받아 둔다
  const cumVolOf = {};
  await Promise.all(data.projects.filter(p => p.cumVolApi).map(async p => { cumVolOf[p.name] = await getJSON(p.cumVolApi); }));
  const cg = cgParts.every(Boolean) ? cgParts.flat() : null;
  const byCg = Object.fromEntries((cg || []).map(c => [c.id, c]));

  // 옵션 거래량: 같은 부모(parent#lyra 등)끼리 합친다. 키 = 부모 또는 slug
  const groups = {};
  for (const p of (opt && opt.protocols) || []) {
    const key = p.parentProtocol || p.slug;
    const g = groups[key] || (groups[key] = { key, name: cleanName(p.displayName || p.name), vol30: 0, vol7: 0, prev30: 0, logo: p.logo, members: [], chain: null, top: -1 });
    if ((p.total30d || 0) > g.top) { g.top = p.total30d || 0; g.chain = (p.chains || [])[0] || null; }
    g.vol30 += p.total30d || 0;
    g.vol7 += p.total7d || 0;
    g.prev30 += p.total60dto30d || 0;
    g.members.push(p.slug);
    (g.mv || (g.mv = {}))[p.slug] = p.total30d || 0;
  }
  // 버전 중 거래량이 큰 것부터 (링크·히스토리가 최신 버전을 가리키게)
  for (const g of Object.values(groups)) g.members.sort((a, b) => g.mv[b] - g.mv[a]);
  const keyOf = {};
  for (const g of Object.values(groups)) { keyOf[g.key] = g; for (const s of g.members) keyOf[s] = g; }
  // 프리미엄(트레이더가 실제로 낸 옵션 값) — 부모/slug 로 합산
  const premOf = {};
  for (const p of (prem && prem.protocols) || []) for (const k of [p.slug, p.parentProtocol].filter(Boolean)) premOf[k] = (premOf[k] || 0) + (p.total30d || 0);

  // TVL·로고: protocols 를 부모/slug 로 묶어 합산
  const tvlOf = {}, logoOf = {}, listedOf = {}, urlOf = {}, twOf = {};
  for (const p of protos || []) {
    if (p.deadUrl || p.rugged) continue;
    for (const k of [p.slug, p.parentProtocol].filter(Boolean)) {
      tvlOf[k] = (tvlOf[k] || 0) + (p.tvl || 0);
      if (!logoOf[k]) logoOf[k] = p.logo;
      if (!urlOf[k] && p.url) urlOf[k] = p.url.replace(/\/$/, '');   // 공식 웹사이트·X 계정 (data.json 에 없을 때만 씀)
      if (!twOf[k] && p.twitter) twOf[k] = p.twitter;
      if (p.listedAt && (!listedOf[k] || p.listedAt < listedOf[k])) listedOf[k] = p.listedAt;   // 부모는 자식 중 가장 이른 등록일
    }
  }
  const prevOf = Object.fromEntries(((opts.prev && opts.prev.projects) || []).map(p => [p.name, p]));

  const projects = data.projects.map(p => {
    const c = byCg[p.cg] || null;
    const keys = p.llama || [];
    const vg = [...new Set(keys.map(k => keyOf[k]).filter(Boolean))];
    const vol30 = vg.reduce((a, g) => a + g.vol30, 0);
    const vol7 = vg.reduce((a, g) => a + g.vol7, 0);
    const prev = prevOf[p.name] || {};
    const tvls = keys.map(k => tvlOf[k]).filter(v => v != null);
    const tvl = protos ? (tvls.length ? tvls.reduce((a, b) => a + b, 0) : null) : (prev.tvl ?? null);
    vg.forEach(g => { g.tracked = p.ticker || p.name; g.name = p.name; g.core = !!p.core; });
    return {
      ...p,
      ticker: p.ticker || (c ? c.symbol.toUpperCase() : ''),
      price: c ? c.current_price : null,
      ch24: c ? c.price_change_percentage_24h : null,
      ch7: c ? c.price_change_percentage_7d_in_currency : null,
      ch30: c ? c.price_change_percentage_30d_in_currency : null,
      mcap: c ? c.market_cap || null : null,
      fdv: c ? c.fully_diluted_valuation : null,
      ath: c ? c.ath : null,
      athDate: c ? c.ath_date : null,
      rank: c ? c.market_cap_rank : null,
      // 토큰이 없으면(프리 TGE) DefiLlama 아이콘. data.json 에 logo 를 직접 적으면 그게 우선
      logo: p.logo || (c && c.image) || keys.map(k => logoOf[k]).find(Boolean) || prev.logo || llamaIcon(p),
      spark: c && c.sparkline_in_7d ? thin(c.sparkline_in_7d.price, 56) : [],
      vol30: vg.length ? vol30 : null,
      vol7: vg.length ? vol7 : null,
      prem30: prem ? (keys.map(k => premOf[k]).find(v => v != null) ?? null) : (prev.prem30 ?? null),
      volSlugs: vg.flatMap(g => g.members),
      tvl,
      site: p.site || keys.map(k => urlOf[k]).find(Boolean) || prev.site || '',
      x: p.x || keys.map(k => twOf[k]).find(Boolean) || prev.x || '',
      // 누적 거래량: s==='ok', 유한한 숫자, failed 소스 없음일 때만(일부 소스가 빠진 응답은 합계가 낮게 나온다). 실패하면 직전 스냅샷 값을 이어받는다 (tvl 과 같은 방식)
      ...(p.cumVolApi ? (() => { const j = cumVolOf[p.name], ok = j && j.s === 'ok' && Number.isFinite(j.data) && !(j.failed || []).length; return { cumVol: ok ? j.data : (prev.cumVol ?? null), cumVolAt: ok ? (j.updatedAt ?? null) : (prev.cumVolAt ?? null) }; })() : {}),
      // 처음 등장: data.json 의 since(YYYY-MM) 가 우선, 없으면 DefiLlama 등록일
      since: p.since || (() => { const t = keys.map(k => listedOf[k]).filter(Boolean); return t.length ? new Date(Math.min(...t) * 1000).toISOString().slice(0, 7) : (prev.since || null); })(),
    };
  });

  const ranking = Object.values(groups)
    .filter(g => g.vol30 > 0)
    .sort((a, b) => b.vol30 - a.vol30)
    .slice(0, 10)
    .map(g => ({ name: g.name, vol30: g.vol30, vol7: g.vol7, prev30: g.prev30, chain: g.chain, logo: g.logo, tracked: g.tracked || null, core: !!g.core }));

  return {
    at: now.toISOString(),
    week: isoWeek(now),
    ok: { prices: !!cg, volume: !!opt },
    headline: data.headline || '',
    relations: data.relations || [],
    majors: MAJORS.map(([id, t]) => { const c = byCg[id]; return c ? { t, price: c.current_price, ch24: c.price_change_percentage_24h } : null; }).filter(Boolean),
    benchmarkFinancials: financials,
    benchmarkMarkets: Object.fromEntries((data.benchmark?.entrants || []).filter(p => p.cg).map(p => {
      const c = byCg[p.cg]; return [p.name, c ? {mcap:c.market_cap ?? null, fdv:c.fully_diluted_valuation ?? null, at:now.toISOString(), source:`https://www.coingecko.com/en/coins/${p.cg}`} : null];
    })),
    projects,
    market: {
      total30: opt ? opt.total30d : null,
      total7: opt ? opt.total7d : null,
      prev30: opt ? opt.total60dto30d : null,
      ranking,
    },
  };
}

function llamaIcon(p) {
  const slug = (p.llama || []).find(s => !s.startsWith('parent#'));
  return slug ? `https://icons.llamao.fi/icons/protocols/${slug}?w=96&h=96` : null;
}

function thin(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * (arr.length - 1) / (n - 1))]);
  return out;
}

// ── 딥다이브용 히스토리 (브라우저에서 프로젝트를 열 때만 부른다) ───────────
async function projectHistory(p) {
  const [price, vols] = await Promise.all([
    p.cg ? getJSON(`https://api.coingecko.com/api/v3/coins/${p.cg}/market_chart?vs_currency=usd&days=365&interval=daily`) : null,
    Promise.all((p.volSlugs || []).map(s => getJSON(`https://api.llama.fi/summary/options/${s}?dataType=dailyNotionalVolume&excludeTotalDataChartBreakdown=true`))),
  ]);
  const day = {};
  for (const v of vols) for (const [t, x] of (v && v.totalDataChart) || []) day[t] = (day[t] || 0) + x;
  return {
    price: price && price.prices ? price.prices.map(([t, v]) => [Math.round(t / 1000), v]) : null,
    priceFail: !!p.cg && !price,
    volume: Object.keys(day).length ? Object.entries(day).map(([t, v]) => [+t, v]).sort((a, b) => a[0] - b[0]) : null,
  };
}

// ── 펀더멘털 그랑프리 ─────────────────────────────────────────
// 레이스마다 F1 점수(25·18·15…)를 주고 합산. 값이 없으면 DNF(토큰 없는 프리 TGE 는 토큰 레이스 불참)
const RACES = [
  { id: 'vol30', label: 'Options volume', sub: '30-day notional', src: 'DefiLlama', unit: 'usd', log: true, get: p => p.vol30 },
  { id: 'prem30', label: 'Premium', sub: '30-day, what traders actually paid', src: 'DefiLlama', unit: 'usd', log: true, get: p => p.prem30 },
  { id: 'tvl', label: 'TVL', sub: 'value locked', src: 'DefiLlama', unit: 'usd', log: true, get: p => p.tvl },
  { id: 'mcap', label: 'Market cap', sub: 'circulating', src: 'CoinGecko', unit: 'usd', log: true, token: true, get: p => p.mcap },
  { id: 'turn', label: 'Turnover', sub: '30d volume ÷ market cap', src: 'DefiLlama ÷ CoinGecko', unit: 'x', log: true, token: true, get: p => p.vol30 && p.mcap ? p.vol30 / p.mcap : null },
  { id: 'ch30', label: '30d price', sub: 'momentum', src: 'CoinGecko', unit: 'pct', token: true, get: p => p.ch30 },
  { id: 'circ', label: 'Circulating', sub: 'higher = less unlock overhang', src: 'CoinGecko', unit: 'share', token: true, get: p => p.mcap && p.fdv ? Math.min(100, p.mcap / p.fdv * 100) : null },
];
const F1 = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

function grandPrix(racers) {
  const races = RACES.map(r => {
    const ok = racers.map(p => ({ p, v: r.get(p) })).filter(x => x.v != null && !isNaN(x.v) && (!r.log || x.v > 0));
    ok.sort((a, b) => b.v - a.v);
    const results = ok.map((x, i) => ({ name: x.p.name, value: x.v, pos: i + 1, pts: F1[i] || 0 }));
    for (const p of racers) if (!ok.some(x => x.p === p)) results.push({ name: p.name, value: null, pos: null, pts: 0 });
    return { race: r, results };
  });
  const table = racers.map(p => {
    const rs = races.map(r => r.results.find(x => x.name === p.name));
    return {
      name: p.name, pts: rs.reduce((a, x) => a + x.pts, 0),
      wins: rs.filter(x => x.pos === 1).length, podiums: rs.filter(x => x.pos && x.pos <= 3).length,
      starts: rs.filter(x => x.pos).length, results: Object.fromEntries(races.map((r, i) => [r.race.id, rs[i].pos])),
    };
  }).sort((a, b) => b.pts - a.pts || b.wins - a.wins || b.podiums - a.podiums);
  return { races, table };
}

// 경쟁사: 고객사가 아닌 곳 중 거래량(없으면 TVL)이 큰 n곳
function rivals(projects, n = 5) {
  return projects.filter(p => !p.core && (p.vol30 || p.tvl))
    .sort((a, b) => (b.vol30 || 0) - (a.vol30 || 0) || (b.tvl || 0) - (a.tvl || 0)).slice(0, n);
}

// 리플레이용 시계열 (노드에서 발행할 때만): 12주 주간 거래량 + 90일 가격
async function raceSeries(snap, wait = ms => new Promise(r => setTimeout(r, ms))) {
  const racers = [...snap.projects.filter(p => p.core), ...rivals(snap.projects)];
  const vol = {}, ret = {};
  const now = Math.floor(Date.now() / 1000), start = now - 13 * 7 * 86400;
  const weeks = []; for (let t = start; t < now; t += 7 * 86400) weeks.push(t);
  for (const p of racers) {
    if (!(p.volSlugs || []).length) continue;
    const parts = await Promise.all(p.volSlugs.map(s => getJSON(`https://api.llama.fi/summary/options/${s}?dataType=dailyNotionalVolume&excludeTotalDataChartBreakdown=true`)));
    const w = weeks.map(() => 0);
    for (const j of parts) for (const [t, v] of (j && j.totalDataChart) || []) { const i = Math.floor((t - start) / (7 * 86400)); if (i >= 0 && i < w.length) w[i] += v; }
    if (w.some(Boolean)) vol[p.name] = w.map(Math.round);
  }
  let days = null;
  for (const p of racers.filter(p => p.cg)) {
    // CoinGecko 무료 한도: 6초 간격, 실패하면 20초 쉬고 최대 3번 더
    let j = null;
    for (let k = 0; k < 4 && !(j && j.prices); k++) {
      if (k) await wait(20000);
      j = await getJSON(`https://api.coingecko.com/api/v3/coins/${p.cg}/market_chart?vs_currency=usd&days=90&interval=daily`, 1);
    }
    await wait(6000);
    if (!j || !j.prices || j.prices.length < 30) continue;
    const pr = j.prices.slice(-91);
    if (!days || pr.length > days.length) days = pr.map(([t]) => Math.round(t / 1000));
    ret[p.name] = pr.map(([, v]) => +((v / pr[0][1] - 1) * 100).toFixed(2));
  }
  return { weeks, vol, days: days || [], ret, racers: racers.map(p => p.name) };
}

// ── 펀더멘털 탭 데이터 (노드에서 발행할 때만) ─────────────────────
// DefiLlama 옵션 개요(일별 거래소별 내역)로 월간 추이·7/30일·전월 대비·누적·90일 추세를 만들고,
// Deribit 공개 API 로 온체인 대 Deribit 24시간 명목 비교를 붙인다.
async function fundamentals(snap) {
  const kinds = { premium: 'dailyPremiumVolume', notional: 'dailyNotionalVolume' };
  const raw = {};
  for (const [k, dt] of Object.entries(kinds)) raw[k] = await getJSON(`https://api.llama.fi/overview/options?dataType=${dt}&excludeTotalDataChart=false&excludeTotalDataChartBreakdown=false`);
  if (!raw.premium || !raw.notional) return null;
  // DefiLlama 프로토콜 → 우리 프로젝트(있으면) 또는 부모 그룹
  const projOf = {};
  for (const p of snap.projects) for (const k of [...(p.llama || []), ...(p.volSlugs || [])]) projOf[k] = p;
  const groupOf = {}, meta = {};
  for (const p of raw.notional.protocols.concat(raw.premium.protocols)) {
    const pr = projOf[p.slug] || projOf[p.parentProtocol];
    const key = pr ? pr.name : cleanName(p.displayName || p.name);
    for (const n of [p.name, p.displayName].filter(Boolean)) groupOf[n] = key;
    groupOf['slug:' + p.slug] = key;
    meta[key] = meta[key] || { name: key, core: !!(pr && pr.core), logo: (pr && pr.logo) || p.logo, url: pr ? llamaUrl(pr) : `https://defillama.com/protocol/${p.slug}`, inList: !!pr };
  }
  const now = new Date(), months = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); }
  const wk0 = Math.floor(Date.now() / 1000) - 13 * 7 * 86400;
  const out = { months, venues: {}, totals: {}, at: snap.at };
  for (const k of Object.keys(kinds)) {
    const j = raw[k], byV = {};
    const v = name => byV[name] || (byV[name] = { m: months.map(() => 0), w: Array(13).fill(0) });
    for (const [t, row] of j.totalDataChartBreakdown) {
      const mi = months.indexOf(new Date(t * 1000).toISOString().slice(0, 7)), wi = Math.floor((t - wk0) / (7 * 86400));
      for (const [pn, x] of Object.entries(row)) {
        if (!x) continue;
        const g = v(groupOf[pn] || pn);
        if (mi >= 0) g.m[mi] += x;
        if (wi >= 0 && wi < 13) g.w[wi] += x;
      }
    }
    const agg = {};
    for (const p of j.protocols) {
      const key = groupOf['slug:' + p.slug] || cleanName(p.name);
      const a = agg[key] || (agg[key] = { d7: 0, d30: 0, prev30: 0, all: 0, d24: 0 });
      a.d7 += p.total7d || 0; a.d30 += p.total30d || 0; a.prev30 += p.total60dto30d || 0; a.all += p.totalAllTime || 0; a.d24 += p.total24h || 0;
    }
    for (const [name, a] of Object.entries(agg)) {
      if (!a.all && !a.d30) continue;
      const ve = out.venues[name] || (out.venues[name] = { ...(meta[name] || { name }) });
      ve[k] = { ...a, m: (byV[name] || {}).m || months.map(() => 0), w: (byV[name] || {}).w || Array(13).fill(0) };
    }
    const tm = months.map(() => 0);
    for (const [t, x] of j.totalDataChart) { const mi = months.indexOf(new Date(t * 1000).toISOString().slice(0, 7)); if (mi >= 0) tm[mi] += x; }
    out.totals[k] = { d30: j.total30d, prev30: j.total60dto30d, all: j.totalAllTime, d24: j.total24h, m: tm };
  }
  out.venues = Object.values(out.venues).map(v => ({ ...v, premium: v.premium || null, notional: v.notional || null }));
  // Deribit: 24시간 옵션 명목(계약 수 × 기초자산 가격)과 프리미엄(volume_usd)
  let dn = 0, dp = 0, ok = 0;
  const currencies = [];
  for (const c of ['BTC', 'ETH', 'SOL', 'XRP']) {
    const j = await getJSON(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${c}&kind=option`);
    if (!j || !j.result) continue; ok++; currencies.push(c);
    for (const r of j.result) { dn += (r.volume || 0) * (r.underlying_price || r.estimated_delivery_price || 0); dp += r.volume_usd || 0; }
  }
  out.deribit = ok ? { notional24: dn, premium24: dp, currencies, coverageComplete: ok === 4 } : null;
  return out;
}

// ── 미결제약정(OI): 거래소 공개 API 에서 직접 (계약 수 × 기초자산 가격) ───────
async function postJSON(url, body) {
  try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function openInterest() {
  const venues = {}, dTot = {};
  const add = (v, u, usdv) => { if (!usdv) return; const x = venues[v] || (venues[v] = { total: 0, byU: {} }); x.total += usdv; x.byU[u] = (x.byU[u] || 0) + usdv; };
  // Derive: 통화별 statistics(open_interest = 계약 수) × 현물가
  const cur = await postJSON('https://api.lyra.finance/public/get_all_currencies', {});
  for (const c of ((cur && cur.result) || []).filter(c => (c.instrument_types || []).includes('option'))) {
    const st = await postJSON('https://api.lyra.finance/public/statistics', { instrument_name: 'ALL', currency: c.currency, instrument_type: 'option' });
    const r = (st && st.result) || {};
    add('Derive', c.currency, (+r.open_interest || 0) * (+c.spot_price || 0));
    if (r.total_notional_volume) dTot[c.currency] = +r.total_notional_volume;   // 누적 → 다음 실행과의 차이 = 24시간 거래량
  }
  // Paradex: 옵션 마켓(…-C / …-P)마다 open_interest × underlying_price.
  // Paradex 는 매수·매도 양쪽을 합친 값을 줘서 절반으로 나눠 한쪽 기준(Derive·Aevo 와 같은 기준)으로 맞춘다
  // (2026-10 확인: 합계가 onchaingreeks 의 Paradex OI 의 정확히 2배였다)
  const px = await getJSON('https://api.prod.paradex.trade/v1/markets/summary?market=ALL');
  for (const m of ((px && px.results) || []).filter(m => /-[CP]$/.test(m.symbol))) add('Paradex', m.symbol.split('-')[0], (+m.open_interest || 0) * (+m.underlying_price || 0) / 2);
  // Aevo: 자산별 statistics(open_interest.total = 계약 수) × index_price
  for (const a of ['ETH', 'BTC', 'SOL', 'HYPE']) {
    const j = await getJSON(`https://api.aevo.xyz/statistics?asset=${a}&instrument_type=OPTION`, 1);
    if (j && j.open_interest) add('Aevo', a, (+j.open_interest.total || 0) * (+j.index_price || 0));
  }
  return Object.keys(venues).length ? { venues, dTot, sources: { Derive: 'https://docs.derive.xyz', Paradex: 'https://docs.paradex.trade', Aevo: 'https://api-docs.aevo.xyz' } } : null;
}

// ── 거래소 부가 데이터: 기초자산별 24시간 명목, 큰 거래(Paradex), 변동성 지수(BVIV·EVIV) ──
async function venueExtras() {
  const volU = { Paradex: {}, Aevo: {} };
  const px = await getJSON('https://api.prod.paradex.trade/v1/markets/summary?market=ALL');
  const opt = ((px && px.results) || []).filter(m => /-[CP]$/.test(m.symbol));
  for (const m of opt) { const u = m.symbol.split('-')[0]; volU.Paradex[u] = (volU.Paradex[u] || 0) + (+m.volume_24h || 0); }
  // 큰 거래: 24시간 거래량 상위 20개 옵션 마켓의 체결을 모아 명목(수량 × 기초가격) 순
  const und = Object.fromEntries(opt.map(m => [m.symbol, +m.underlying_price || 0]));
  const active = opt.filter(m => +m.volume_24h > 0).sort((a, b) => b.volume_24h - a.volume_24h).slice(0, 20);
  const since = Date.now() - 864e5, trades = [];
  for (const m of active) {
    const j = await getJSON(`https://api.prod.paradex.trade/v1/trades?market=${m.symbol}&page_size=100`, 1);
    for (const t of (j && j.results) || []) if (t.created_at >= since)
      trades.push({ venue: 'Paradex', market: t.market, side: t.side, size: +t.size, premium: +t.price * +t.size, notional: +t.size * und[t.market], t: t.created_at });
  }
  trades.sort((a, b) => b.notional - a.notional);
  for (const a of ['ETH', 'BTC']) { const j = await getJSON(`https://api.aevo.xyz/statistics?asset=${a}&instrument_type=OPTION`, 1); if (j && j.daily_volume) volU.Aevo[a] = +j.daily_volume; }
  // Volmex 변동성 지수 무기한 (Hyperliquid 'mkts' 거래소)
  const vol = {};
  const hl = await postJSON('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs', dex: 'mkts' });
  if (hl && hl[0]) hl[0].universe.forEach((u, i) => { const m = /^mkts:(BVIV|EVIV)$/.exec(u.name); const c = hl[1][i]; if (m && c) vol[m[1]] = { px: +c.oraclePx || +c.markPx, prev: +c.prevDayPx, oi: +c.openInterest, vol24: +c.dayNtlVlm }; });
  return { volU, trades: trades.slice(0, 15), vol };
}

// Derivatives Monkey 공개 API: 12개 거래소(CEX + 온체인) 옵션을 한 기준으로 모은 시장 상태
// BTC·ETH 시장 요약(IV·감마·월·풋콜) + 변동성 콘 + 기간구조 + 거래소별 OI
const DM = 'https://www.derivativesmonkey.com/api/market';
const DM_ASSETS = ['btc', 'eth', 'sol', 'hype', 'zec'];
const DM_SRC = ['deribit', 'okx', 'bybit', 'binance', 'bullish', 'delta', 'derive', 'paradex', 'aevo', 'thalex', 'callput', 'hypercall'];
// 옵션 심리: 25델타 리스크 리버설(콜−풋 IV, 14일) · 그 7일 변화 · 풋/콜 OI · 24시간 프리미엄 흐름
async function dmSentiment(a, all) {
  const med = xs => { xs = xs.filter(x => x != null && isFinite(x)).sort((p, q) => p - q); return xs.length ? xs[xs.length >> 1] : null; };
  const [rr, flow, sbm] = await Promise.all([
    getJSON(`${DM}/rr-history?asset=${a}`, 2), getJSON(`${DM}/flow-summary?asset=${a}&sources=${all}`, 2), getJSON(`${DM}/skew-by-maturity?asset=${a}&sources=${all}`, 2)]);
  const o = {};
  if (rr && rr.current_rr && rr.points && rr.points.length) {
    const rowMed = p => med(Object.entries(p).filter(([k]) => k !== 'ts_ms').map(([, v]) => v));
    const last = rr.points[rr.points.length - 1], wk = rr.points.find(p => p.ts_ms >= last.ts_ms - 7 * 864e5) || rr.points[0];
    o.rr = med(Object.values(rr.current_rr)); o.rr7 = rowMed(wk); o.rrTenor = rr.tenor_days;
    o.rrPts = rr.points.filter((p, i) => i % 6 === 0 || i === rr.points.length - 1).map(p => [p.ts_ms, rowMed(p)]);
  }
  if (flow && flow.rows) {
    const f = { C: { buy: 0, sell: 0 }, P: { buy: 0, sell: 0 } };
    for (const r of flow.rows) if (f[r.option_type] && r.direction in f[r.option_type]) f[r.option_type][r.direction] += r.total_premium || 0;
    o.flow = f; o.flowSince = flow.since_ms;
  }
  if (sbm && sbm.items) {
    const by = {}; for (const it of sbm.items) if (it.dte_days <= 100) (by[it.expiry_date] = by[it.expiry_date] || { dte: it.dte_days, v: [] }).v.push(it.rr_25d);
    o.skew = Object.entries(by).map(([d, x]) => ({ d, dte: x.dte, rr: med(x.v) })).sort((p, q) => p.dte - q.dte);
  }
  return o;
}

async function dmMarket() {
  const out = { at: Date.now(), assets: {}, venues: [] };
  // 코인마다 옵션이 있는 거래소가 다르다 (ZEC = Derive·Paradex, HYPE = Derive·Paradex·Aevo·Deribit·Bybit)
  const srcAll = await getJSON(`${DM}/sources-all`, 2);
  for (const a of DM_ASSETS) {
    const avail = srcAll && srcAll.assets && srcAll.assets[a] ? srcAll.assets[a].sources : (['btc', 'eth'].includes(a) ? DM_SRC : []);
    if (!avail.length) continue;
    const all = avail.join(',');
    const [sum, cone, term] = await Promise.all([
      getJSON(`${DM}/market-summary?asset=${a}&sources=${all}`, 2),
      getJSON(`${DM}/vol-cone?asset=${a}`, 2),
      getJSON(`${DM}/term-structure?asset=${a}&sources=${all}`, 2),
    ]);
    if (!sum || !sum.spot) continue;
    const v = x => x && typeof x === 'object' ? x.value : x;
    out.assets[a.toUpperCase()] = {
      spot: v(sum.spot), iv7: v(sum.atm_iv_7d), iv30: v(sum.atm_iv_30d), term: sum.term, gamma: sum.net_gamma, pc: sum.pc,
      callWall: sum.call_wall, putWall: sum.put_wall, topExpiry: sum.top_expiry, rv: sum.rv, ivPct: sum.iv_percentile, flip: sum.gamma_flip,
      oi: v(sum.total_oi), cone: ((cone && cone.cones) || []).map(c => ({ w: c.window_days, hv: c.hv_current * 100, iv: c.iv_atm, lo: c.hv_10pct * 100, hi: c.hv_90pct * 100, rank: c.iv_pct_rank })),
      termPts: ((term && term.points) || []).filter(p => p.atm_iv > 0).map(p => ({ d: p.expiry_date, dte: p.dte_days, iv: p.atm_iv })),
    };
    out.assets[a.toUpperCase()].senti = await dmSentiment(a, all);
  }
  // 거래소별 OI (코인 수 × 현물가, BTC+ETH). Paradex 는 양쪽을 다 세서 ÷2
  for (const s of DM_SRC) {
    const row = { venue: s, btc: 0, eth: 0 };
    for (const a of ['btc', 'eth']) {
      const j = await getJSON(`${DM}/market-summary?asset=${a}&sources=${s}`, 1);
      const oi = j && j.total_oi && j.total_oi.value, px = j && j.spot && j.spot.value;
      if (oi && px) row[a] = oi * px / (s === 'paradex' ? 2 : 1);
    }
    row.total = row.btc + row.eth;
    if (row.total > 0) out.venues.push(row);
  }
  out.venues.sort((a, b) => b.total - a.total);
  return Object.keys(out.assets).length ? out : null;
}

// 이번 주 미국 고영향 지표 (Forex Factory 공개 JSON — 이번 주만 제공, 월요일에 새 주)
async function macroWeek() {
  const j = await getJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 2);
  if (!Array.isArray(j)) return null;
  return j.filter(e => e.impact === 'High' && (e.country === 'USD' || e.country === 'All'))
    .map(e => ({ date: e.date, title: e.title, forecast: e.forecast || '', previous: e.previous || '' }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

// 심리 점수 (노드·브라우저 공용): 각 근거를 −1..+1 로, 가중 평균. 없는 근거는 빼고 다시 나눈다
const sentiVerdict = s => s > .35 ? 'BULLISH' : s > .1 ? 'LEANING BULLISH' : s < -.35 ? 'BEARISH' : s < -.1 ? 'LEANING BEARISH' : 'NEUTRAL';
function sentiScore(x) {
  const cl = v => Math.max(-1, Math.min(1, v)), parts = [];
  if (x.rr != null) parts.push(['rr', .35, cl(x.rr / 4)]);
  if (x.rr != null && x.rr7 != null) parts.push(['rr7', .2, cl((x.rr - x.rr7) / 4)]);
  if (x.pc != null) parts.push(['pc', .2, cl((1 - x.pc) / .6)]);
  if (x.flowTot > 0) parts.push(['flow', .15, cl((x.flowC - x.flowP) / x.flowTot * 5)]);
  if (x.near != null) parts.push(['near', .1, cl(x.near / 3)]);
  if (!parts.length) return null;
  const w = parts.reduce((a, p) => a + p[1], 0), score = parts.reduce((a, p) => a + p[1] * p[2], 0) / w;
  return { score, verdict: sentiVerdict(score), parts: Object.fromEntries(parts.map(p => [p[0], p[2]])) };
}
function sentiInputs(A) {
  const S = (A && A.senti) || {}, f = S.flow, near = (S.skew || []).filter(x => x.dte < 3 && x.rr != null);
  return { rr: S.rr, rr7: S.rr7, pc: A && A.pc ? A.pc.ratio : null,
    flowC: f ? f.C.buy - f.C.sell : 0, flowP: f ? f.P.buy - f.P.sell : 0, flowTot: f ? f.C.buy + f.C.sell + f.P.buy + f.P.sell : 0,
    near: near.length ? near.reduce((a, x) => a + x.rr, 0) / near.length : null };
}
// BTC·ETH 1년 일별 가격 (심리 일지 차트·"그 뒤 7일" 계산용)
async function majorsHistory() {
  const out = {};
  for (const [id, t] of [['bitcoin', 'BTC'], ['ethereum', 'ETH'], ['solana', 'SOL'], ['hyperliquid', 'HYPE'], ['zcash', 'ZEC']]) {
    const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`, 3);
    if (j && j.prices) out[t] = j.prices.map(([ts, p]) => [ts, +p.toPrecision(6)]);
  }
  return Object.keys(out).length ? out : null;
}

// 매크로 패널 옆 차트: BTC · 나스닥100 선물 1시간봉 (최근 4일). 바이낸스는 미국 IP 차단이라 공개 미러 사용
async function macroTape() {
  const out = {};
  const bk = await getJSON('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=96', 3);
  if (Array.isArray(bk)) out.BTC = bk.map(r => [r[0], +(+r[1]).toFixed(1), +(+r[2]).toFixed(1), +(+r[3]).toFixed(1), +(+r[4]).toFixed(1)]);
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/NQ=F?interval=60m&range=5d', { headers: { 'user-agent': 'Mozilla/5.0' } });
    const j = r.ok ? await r.json() : null, c = j && j.chart && j.chart.result && j.chart.result[0];
    if (c) {
      const q = c.indicators.quote[0], rows = [];
      c.timestamp.forEach((t, i) => { if ([q.open[i], q.high[i], q.low[i], q.close[i]].every(v => v != null)) rows.push([t * 1000, +q.open[i].toFixed(2), +q.high[i].toFixed(2), +q.low[i].toFixed(2), +q.close[i].toFixed(2)]); });
      out.NQ = rows.filter(r => r[0] % 36e5 === 0).slice(-96);
    }
  } catch {}
  return Object.keys(out).length ? { at: Date.now(), ...out } : null;
}

// 원본 페이지: DefiLlama 지표는 프로토콜 페이지, CoinGecko 지표는 코인 페이지
function llamaUrl(p) {
  const s = (p.volSlugs || [])[0] || (p.llama || []).find(k => !k.startsWith('parent#')) || ((p.llama || [])[0] || '').replace('parent#', '');
  return s ? `https://defillama.com/protocol/${s}` : null;
}
const cgUrl = p => p.cg ? `https://www.coingecko.com/en/coins/${p.cg}` : null;

if (typeof module !== 'undefined') module.exports = { collect, history: projectHistory, isoWeek, grandPrix, rivals, raceSeries, fundamentals, openInterest, venueExtras, dmMarket, macroWeek, sentiScore, sentiInputs, sentiVerdict, majorsHistory, macroTape, RACES, llamaUrl, cgUrl };

// Source-specific financial coverage; parent token economics and options adapters stay separate.
async function benchmarkFinancials(data) {
  const metrics={holders:'dailyHoldersRevenue',revenue:'dailyRevenue',fees:'dailyFees'};
  const sources=Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k,`https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=${v}`]));
  const responses=Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([k,url])=>[k,await getJSON(url)])));
  const projects={};
  for(const p of data.projects){
    const keys=new Set(p.llama || []), record={};
    for(const [metric,j] of Object.entries(responses)){
      const seen=new Set(), matches=(j?.protocols || []).filter(x=>(keys.has(x.slug)||keys.has(x.parentProtocol)) && !seen.has(x.slug) && seen.add(x.slug));
      const present=matches.filter(x=>typeof x.total30d==='number' && Number.isFinite(x.total30d));
      record[metric]=present.length?present.reduce((s,x)=>s+x.total30d,0):null;
      record[metric+'Adapters']=present.map(x=>x.slug);
      const options=present.filter(x=>/options/i.test(x.name));
      if(metric==='fees'||metric==='revenue')record['options'+metric[0].toUpperCase()+metric.slice(1)]=options.length?options.reduce((s,x)=>s+x.total30d,0):null;
      if(metric==='fees')record.optionsAdapters=options.map(x=>x.slug);
    }
    if(['holders','revenue','fees'].some(k=>record[k]!=null))projects[p.name]=record;
  }
  return {at:new Date().toISOString(),period:'Provider rolling last 30 days',scope:'Protocol-wide for holders; explicitly named options adapters for chart fee rings',projects,sources};
}
