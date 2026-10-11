# Korean Opshnz

Onchain options ecosystem dashboard — **sentiment → data → projects**.
Made by [0xdefidaniel](https://x.com/0xdefidaniel).

- `index.html` — the site (open it, or serve the repo with GitHub Pages)
- Rebuilt every morning (10:05 KST) by GitHub Actions — `.github/workflows/daily.yml`
- Data: DefiLlama, CoinGecko, Derivatives Monkey, Deribit, Derive, Paradex, Aevo, Hyperliquid, Forex Factory

## Editing
- Text, notes, friends, scenarios: `data.json` · ref codes: `refs.json` · content: `content.json`
- Local editor with live preview: `node editor.mjs` → http://localhost:4848
- Full rebuild by hand: `node publish.mjs --dry`
