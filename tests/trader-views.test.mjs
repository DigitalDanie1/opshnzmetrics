import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../template.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function traderViewWindow('),html.indexOf('function renderTraderViews('));const ctx=vm.createContext({});vm.runInContext(source,ctx);
const item=(id,date,url='https://example.com/'+id)=>({id,date,url,publisher:'Desk',view:'Attributed view'});
const data={items:[item('fresh','2026-10-12'),item('old','2026-10-01'),item('future','2026-10-16'),item('unsafe','2026-10-12','javascript:alert(1)')],archive:[item('fresh','2026-10-12')]};
const out=ctx.traderViewWindow(data,Date.parse('2026-10-15T09:00:00+09:00'));
assert.equal(out.current.length,1);assert.equal(out.current[0].id,'fresh');assert.equal(out.older.length,1);assert.equal(out.older[0].id,'old');
const cfg=JSON.parse(fs.readFileSync(new URL('../data.json',import.meta.url),'utf8'));for(const v of cfg.traderViews.items){for(const k of ['id','publisher','date','assets','horizon','view','url'])assert.ok(v[k]);}
assert.ok(html.includes('renderTraderViews();'));
console.log('Trader views: freshness, archival, future exclusion, duplicate removal, safe links and source fields passed.');
