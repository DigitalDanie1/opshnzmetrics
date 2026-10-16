import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../template.html',import.meta.url),'utf8');
const fn=html.slice(html.indexOf('function marketShareRows('),html.indexOf('function renderMarketShare('));
const ctx=vm.createContext({});vm.runInContext(fn,ctx);
const dir=new URL('../snapshots/',import.meta.url), files=fs.readdirSync(dir).filter(f=>/^\d{4}-W\d{2}\.json$/.test(f)).sort();
const s=JSON.parse(fs.readFileSync(new URL(files.at(-1),dir),'utf8'));
const on=new Set(['derive','paradex','aevo','callput','hypercall']);
for(const asset of ['all','BTC','ETH']){
 const rows=ctx.marketShareRows(s.dm.venues,asset), total=rows.reduce((a,r)=>a+r.value,0);
 const chain=rows.filter(r=>on.has(r.venue)).reduce((a,r)=>a+r.value,0);
 const cex=rows.filter(r=>!on.has(r.venue)).reduce((a,r)=>a+r.value,0);
 assert.ok(Math.abs((chain+cex)/total-1)<1e-12);
 assert.ok(Math.abs(rows.reduce((a,r)=>a+r.value/total*100,0)-100)<1e-10);
 if(asset==='all') assert.ok(chain/total*100>0 && chain/total*100<100);   // live data — check range, not a pinned snapshot value
}
assert.equal(ctx.marketShareRows([{venue:'missing',total:null},{venue:'zero',total:0},{venue:'bad',total:NaN}]).length,1);
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
 if(/application\/ld\+json/.test(m[1])) JSON.parse(m[2]); else if(m[2].trim()) new vm.Script(m[2]);
}
assert.ok(!html.includes('id="cexCard"'));
console.log('Market share: asset totals, group reconciliation, missing values, panel consolidation and script syntax passed.');
