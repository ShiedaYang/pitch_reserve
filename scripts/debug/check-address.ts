import assert from 'node:assert/strict';
// Diagnostic for supplier lookup options only. Manual-address mode can allow
// continuation even while this lookup remains empty; this is not a wizard test.
const base = 'http://127.0.0.1:4318';
const state = await (await fetch(`${base}/api/state`)).json();
const res = await fetch(`${base}/api/providers/council/inspect`, { method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:'{}' });
assert.equal(res.status,200);
const inspection = await res.json();
const address = inspection.frames.flatMap((frame: { selects?: Array<{id:string;options:Array<{value:string}>}> }) => frame.selects || []).find((select: {id:string})=>select.id==='addressSelector');
const count = address?.options.filter((option: {value:string})=>option.value!=='').length || 0;
console.log(`Council address selector: ${count} selectable addresses. No postcode, address, or account details captured.`);
assert.ok(count>0,'Address selection unavailable: supplier dropdown has no address results');
