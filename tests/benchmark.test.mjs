import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html = fs.readFileSync(new URL('../template.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function benchmarkCalculation('), html.indexOf('function benchmarkState('));
const ctx = vm.createContext({}); vm.runInContext(source, ctx);
const calc = ctx.benchmarkCalculation;
// Equal activity / valuation shares should match Deribit's benchmark exactly.
assert.equal(calc(430e6, 3.56e9, 4.3e9, 35.6e9).multiple, 1);
assert.equal(calc(860e6, 3.56e9, 4.3e9, 35.6e9).multiple, 2);
assert.equal(calc(860e6, 3.56e9, 4.3e9, 35.6e9, .5).multiple, 1);
assert.equal(calc(215e6, 3.56e9, 4.3e9, 35.6e9).change, -50);
for (const args of [[null,1,1,1],[1,0,1,1],[1,1,0,1],[1,1,1,NaN],[Infinity,1,1,1],[1,1,1,1,0],[1,1,1,1,1.1]]) assert.equal(calc(...args), null);
const r=calc(664833882,1366887660.1167006,4.3e9,35595434722.37002);
assert.ok(Math.abs(r.multiple - 4.0262) < .001);
assert.ok(Math.abs(r.parity / 1366887660.1167006 - r.multiple) < 1e-12);
console.log('Benchmark: parity, premium, discount, attribution, missing inputs and snapshot arithmetic passed.');
// Daily premium and daily notional give different cross-checks on the same token value.
const premiumCheck=calc(664833882,1634671,4.3e9,60459028.59000002);
const volumeCheck=calc(664833882,57454615,4.3e9,1466112898.842167);
assert.ok(Math.abs(premiumCheck.multiple-5.718)<.01);
assert.ok(Math.abs(volumeCheck.multiple-3.945)<.01);
assert.notEqual(premiumCheck.multiple,volumeCheck.multiple);
console.log('Daily premium and daily notional benchmark cross-checks passed.');
