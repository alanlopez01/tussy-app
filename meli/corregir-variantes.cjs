const fs = require('fs');
const assert = require('node:assert/strict');
for (const p of ['.env.local', '.env.development.local']) for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const dir = 'meli/auditoria-variantes';
const before = JSON.parse(fs.readFileSync(`${dir}/antes.json`));
// Indices de las fotos del snapshot, revisadas visualmente y contrastadas con TN.
const groups = {
  1: { Negro: [1,2,3,0,4], Crudo: [5,6,7,8] },
  2: { Blanco: [0,1,2,3,4,5] },
  6: { Negro: [2], 'Negro c/Blanco': [0], Gris: [1] },
  9: { Gris: [2,3], Negro: [0,1] },
  10: { Negro: [0,1] },
  11: { Negro: [2], Blanco: [0,1], Azul: [3] },
  19: { Negro: [0,1,2,3,4,5], Blanco: [6] },
  20: { Negro: [4,5], Blanco: [0,1,2,3] },
  25: { Negro: [0,1,2,3], Blanco: [6,7] },
  29: { Negro: [0,1,2,3,4,5] },
  32: { Negro: [4,5], Blanco: [2,3] },
  33: { Negro: [3,5,4,6] },
  37: { Blanco: [0,1,2], Negro: [4,5], Azul: [7,8] },
  38: { Negro: [1], Azul: [2,3,4] },
};
const color = v => v.attribute_combinations.find(a => a.id === 'COLOR')?.value_name;
const invariant = item => ({
  status: item.status, sub_status: item.sub_status, title: item.title, price: item.price,
  available_quantity: item.available_quantity,
  variations: item.variations.map(v => ({ id: v.id, price: v.price, available_quantity: v.available_quantity, attribute_combinations: v.attribute_combinations, seller_custom_field: v.seller_custom_field, attributes: v.attributes })).sort((a,b)=>a.id-b.id),
});
async function main() {
  const token = await require('../api/meli').tokenValido();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function get(id) {
    const r = await fetch(`https://api.mercadolibre.com/items/${id}`, { headers });
    const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j;
  }
  const plan = Object.entries(groups).map(([n,g]) => {
    const p = before[n];
    return { item_id: p.item_id, name: p.tn_nombre, variations: p.item.variations.map(v => {
      assert(g[color(v)], `Falta color ${p.tn_nombre} ${color(v)}`);
      const picture_ids = g[color(v)].map(i => { assert(p.item.pictures[i]); return p.item.pictures[i].id; });
      assert(picture_ids.length >= 1 && picture_ids.length <= 10);
      return { id: v.id, picture_ids };
    }) };
  });
  fs.writeFileSync(`${dir}/plan-fotos.json`, JSON.stringify(plan, null, 2));
  if (!process.argv.includes('--aplicar')) { console.log(`Plan: ${plan.length} publicaciones, ${plan.reduce((n,p)=>n+p.variations.length,0)} variantes.`); return; }
  const results = [];
  for (const p of plan) {
    const original = before.find(x => x.item_id === p.item_id).item;
    const current = await get(p.item_id);
    assert.deepEqual(invariant(current), invariant(original), `Publicación modificada desde snapshot: ${p.item_id}`);
    assert.equal(current.status, 'paused');
    assert.deepEqual(current.pictures.map(p=>p.id), original.pictures.map(p=>p.id));
    const r = await fetch(`https://api.mercadolibre.com/items/${p.item_id}`, { method: 'PUT', headers, body: JSON.stringify({ variations: p.variations }) });
    const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify({ id:p.item_id,status:r.status,message:j }));
    const after = await get(p.item_id);
    results.push({ item_id: p.item_id, name:p.name, after });
    fs.writeFileSync(`${dir}/despues.json`, JSON.stringify(results, null, 2));
    assert.deepEqual(invariant(after), invariant(original), `Cambió un dato ajeno a fotos: ${p.item_id}`);
    for (const v of p.variations) assert.deepEqual(after.variations.find(a=>a.id===v.id).picture_ids, v.picture_ids);
    console.log(`OK ${p.name}: ${p.variations.length} variantes; pausada, stock y precio intactos`);
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
