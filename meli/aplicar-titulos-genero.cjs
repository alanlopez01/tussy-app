const fs = require('fs');
const assert = require('node:assert/strict');
for (const p of ['.env.local','.env.development.local']) for (const l of fs.readFileSync(p,'utf8').split('\n')) {
  const m=l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2];
}
const dir='meli/auditoria-variantes';
const proposal=JSON.parse(fs.readFileSync(`${dir}/titulos-propuestos.json`));
const baseline=JSON.parse(fs.readFileSync(`${dir}/antes.json`));
const clothes = name => /^(REMERA|BUZO|CAMPERA|PANTALON|SWEATER)\b/.test(name);
const invariant = j => ({price:j.price,available_quantity:j.available_quantity,pictures:j.pictures.map(p=>p.id),variations:j.variations});
async function main(){
 const token=await require('../api/meli').tokenValido();
 const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 const call=async(url,options={})=>{const r=await fetch('https://api.mercadolibre.com'+url,{headers,...options});const j=await r.json();if(!r.ok)throw Error(JSON.stringify({url,status:r.status,data:j}));return j;};
 const snapshots=fs.existsSync(`${dir}/titulos-antes.json`)?JSON.parse(fs.readFileSync(`${dir}/titulos-antes.json`)):[];
 for(const p of proposal.items){
  assert(!/\b(hombre|unisex)\b/i.test(p.proposed));assert(p.proposed.length<=60);
  if(!snapshots.some(x=>x.item_id===p.item_id))snapshots.push({item_id:p.item_id,name:baseline.find(b=>b.item_id===p.item_id).tn_nombre,before:await call('/items/'+p.item_id)});
 }
 fs.writeFileSync(`${dir}/titulos-antes.json`,JSON.stringify(snapshots,null,2));
 const categories={};
 for(const p of snapshots.filter(p=>clothes(p.name))){
  if(!categories[p.before.category_id])categories[p.before.category_id]=await call(`/categories/${p.before.category_id}/attributes`);
  const gender=categories[p.before.category_id].find(a=>a.id==='GENDER');
  const neutral=gender?.values?.find(v=>v.name.toLowerCase()==='sin género');
  assert(neutral,`Sin género no permitido en ${p.name}`);p.gender=neutral;
 }
 const results=[];
 for(const p of snapshots){
  const target=proposal.items.find(x=>x.item_id===p.item_id);
  const body={title:target.proposed,status:'paused'};
  if(p.gender)body.attributes=[{id:'GENDER',value_id:p.gender.id}];
  const updated=await call('/items/'+p.item_id,{method:'PUT',body:JSON.stringify(body)});
  const after=await call('/items/'+p.item_id);
  results.push({item_id:p.item_id,name:p.name,before:p.before,after});
  fs.writeFileSync(`${dir}/titulos-despues.json`,JSON.stringify(results,null,2));
  assert.equal(after.title.toLocaleLowerCase(),target.proposed.toLocaleLowerCase());assert.equal(after.status,'paused');
  assert.deepEqual(invariant(after),invariant(p.before),`Cambió stock, variantes o fotos: ${p.name}`);
  if(p.gender)assert.equal(after.attributes.find(a=>a.id==='GENDER')?.value_name,'Sin género');
  for(const attr of p.before.attributes.filter(a=>a.id!=='GENDER'))assert.deepEqual(after.attributes.find(a=>a.id===attr.id),attr,`Cambió ${attr.id}`);
  target.applied=true;target.current=after.title;
  fs.writeFileSync(`${dir}/titulos-propuestos.json`,JSON.stringify(proposal,null,2));
  console.log(`OK ${p.name}: ${after.title} · ${after.attributes.find(a=>a.id==='GENDER')?.value_name||'sin atributo'} · pausada`);
 }
 proposal.status='Aplicados y verificados en MELI';fs.writeFileSync(`${dir}/titulos-propuestos.json`,JSON.stringify(proposal,null,2));
 console.log(JSON.stringify({titles:results.length,neutralClothes:snapshots.filter(p=>p.gender).length}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
