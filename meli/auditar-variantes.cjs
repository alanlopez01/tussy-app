const fs = require('fs');
const path = require('path');
for (const p of ['.env.local', '.env.development.local']) for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const dir = path.resolve('meli/auditoria-variantes');
fs.mkdirSync(dir, { recursive: true });
async function main() {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const pubs = await sql`SELECT item_id, tn_id, tn_nombre FROM meli_publicaciones ORDER BY tn_nombre`;
  const token = await require('../api/meli').tokenValido();
  const data = [];
  for (let i = 0; i < pubs.length; i += 4) {
    const batch = await Promise.all(pubs.slice(i, i + 4).map(async pub => {
      const r = await fetch(`https://api.mercadolibre.com/items/${pub.item_id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`${pub.item_id}: ${r.status}`);
      const item = await r.json();
      let tn = null;
      if (process.env.TN_ACCESS_TOKEN && process.env.TN_USER_ID) {
        const tr = await fetch(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/${pub.tn_id}`, { headers: { Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`, 'User-Agent': 'TussyApp/1.0' } });
        if (tr.ok) tn = await tr.json();
      }
      return { ...pub, item, tn };
    }));
    data.push(...batch);
  }
  fs.writeFileSync(path.join(dir, 'antes.json'), JSON.stringify(data, null, 2));
  for (const [n, p] of data.entries()) {
    const colors = {};
    for (const v of p.item.variations || []) {
      const c = v.attribute_combinations?.find(a => a.id === 'COLOR')?.value_name || '(sin color)';
      (colors[c] ||= []).push(v.id);
    }
    console.log(JSON.stringify({ n, name: p.tn_nombre, status: p.item.status, pictures: p.item.pictures.length, colors, tn: !!p.tn }));
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
