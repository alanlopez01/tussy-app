const fs=require('fs');
for(const p of ['.env.local','.env.development.local'])for(const l of fs.readFileSync(p,'utf8').split('\n')){const m=l.match(/^([A-Z_0-9]+)="?([^"]*)"?$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}
async function main(){
 const {neon}=require('@neondatabase/serverless');const sql=neon(process.env.DATABASE_URL);
 const linked=await sql`SELECT item_id,tn_id,tn_nombre FROM meli_publicaciones`;
 const tn=[];
 for(let page=1;;page++){
  const r=await fetch(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products?per_page=200&page=${page}`,{headers:{Authentication:`bearer ${process.env.TN_ACCESS_TOKEN}`,'User-Agent':'TussyApp/1.0'}});
  if(r.status===404)break;if(!r.ok)throw Error('TN '+r.status);const batch=await r.json();tn.push(...batch);if(batch.length<200)break;
 }
 fs.writeFileSync('meli/auditoria-variantes/tiendanube-catalogo-actual.json',JSON.stringify(tn,null,2));
 const token=await require('../api/meli').tokenValido();const headers={Authorization:`Bearer ${token}`};
 const me=await (await fetch('https://api.mercadolibre.com/users/me',{headers})).json();if(!me.id)throw Error('No seller ID');
 const ids=[];
 for(let offset=0;;offset+=50){const r=await fetch(`https://api.mercadolibre.com/users/${me.id}/items/search?limit=50&offset=${offset}`,{headers});if(!r.ok)throw Error('MELI search '+r.status);const j=await r.json();ids.push(...j.results);if(offset+50>=j.paging.total)break;}
 const untracked=ids.filter(id=>!linked.some(p=>p.item_id===id));const extra=[];
 for(const id of untracked){const r=await fetch('https://api.mercadolibre.com/items/'+id,{headers});if(!r.ok)throw Error('MELI item '+r.status);extra.push(await r.json());}
 const norm=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
 const missing=tn.filter(p=>!linked.some(l=>String(l.tn_id)===String(p.id))).map(p=>{
  const name=p.name.es||Object.values(p.name)[0];const managed=p.variants.filter(v=>v.stock_management);const stock=managed.reduce((n,v)=>n+Number(v.stock||0),0);const unlimited=p.variants.some(v=>!v.stock_management||v.stock===null);
  const skus=new Set(p.variants.map(v=>v.sku).filter(Boolean));
  const candidate=extra.filter(i=>norm(i.title)===norm(name)||i.variations?.some(v=>skus.has(v.seller_custom_field)||v.attributes?.some(a=>a.id==='SELLER_SKU'&&skus.has(a.value_name))));
  return {id:p.id,name,published:p.published,created_at:p.created_at,updated_at:p.updated_at,managedStock:stock,unlimited,variants:p.variants.length,images:p.images.length,url:p.canonical_url,candidateMeli:candidate.map(i=>({id:i.id,title:i.title,status:i.status}))};
 });
 const out={date:'2026-10-19',tnProducts:tn.length,meliItems:ids.length,linkedProducts:linked.length,untrackedMeli:extra.map(i=>({id:i.id,title:i.title,status:i.status})),missing};
 fs.writeFileSync('meli/auditoria-variantes/comparacion-catalogo.json',JSON.stringify(out,null,2));
 console.log(JSON.stringify({tnProducts:out.tnProducts,meliItems:out.meliItems,missing:out.missing.length,publishedMissing:out.missing.filter(p=>p.published).length}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
