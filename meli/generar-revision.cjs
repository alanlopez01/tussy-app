const fs = require('fs');
const data = require('./auditoria-variantes/antes.json');
const changes = require('./auditoria-variantes/plan-fotos.json');
const appliedPath = 'meli/auditoria-variantes/titulos-despues.json';
const applied = fs.existsSync(appliedPath) ? JSON.parse(fs.readFileSync(appliedPath)) : [];
const fullyApplied = applied.length === data.length;
const sources = {
  bull: 'https://www.mercadolibre.com.ar/tienda/bullbenny',
  bomba: 'https://www.mercadolibre.com.ar/tienda/bomba-project',
  king: 'https://articulo.mercadolibre.com.ar/MLA-1592835691-remera-oversize-fit-king-of-the-kongo-acid-black-_JM',
  kingPants: 'https://articulo.mercadolibre.com.ar/MLA-2581080096-pantalon-jean-mega-baggy-denim-king-of-the-kongo-sin-genero-_JM',
  narrow: 'https://www.mercadolibre.com.ar/remera-classic-tee-narrow/up/MLAU3680178877',
  meli: 'https://vendedores.mercadolibre.com.ar/nota/como-hacer-un-buen-titulo-para-tu-publicacion?guideKeyId=GE53&moduleKeyId=MO282',
};
const titles = {
  'BOLSO BELT': 'Cartera Bandolera Tussy Belt Con Correa',
  'BOLSO CHEW': 'Cartera Bandolera Tussy Chew Con Correa',
  'BOLSO POCKET': 'Cartera Bandolera Tussy Pocket Con Monedero',
  'BOLSO SQUARE': 'Cartera Bandolera Tussy Square Con Correa',
  'BOLSO TRAVEL': 'Bolso De Viaje Tussy Travel Con Correa',
  'BOLSO VALHALA': 'Cartera Bandolera Tussy Valhala Con Cadena',
  'BOXER ALWAYS': 'Boxer Tussy Always Algodón Hombre Unidad',
  'BOXER T-COM': 'Boxer Tussy T-Com Algodón Hombre Unidad',
  'BOXER T-COM LINE': 'Boxer Tussy T-Com Line Algodón Hombre Unidad',
  'BOXER TUSSY': 'Boxer Tussy Algodón Hombre Unidad',
  'BUZO OVERSIZE BLUE JAYS': 'Buzo Oversize Tussy Blue Jays Con Capucha Hombre',
  'CAMPERA TEJIDA BRICKELL': 'Campera Tejida Tussy Brickell Con Capucha Y Cierre',
  'CAMPERA TSSY ASIMOV': 'Campera Tussy Asimov Con Cierre Hombre',
  'CAMPERA TSSY DIZZY': 'Campera Tussy Dizzy Con Capucha Y Cierre Hombre',
  'GORRA SCOUT': 'Gorra Tussy Scout Camuflada Unisex',
  'MOCHILA TSSY': 'Mochila Urbana Tussy Con Solapa Unisex',
  'PANTALON BAGGY TSSY ASIMOV': 'Pantalón Baggy Tussy Asimov Deportivo Hombre',
  'PIN TUSSY SY': 'Pin Tussy Sy Logo Accesorio',
  'PIN TUSSY T': 'Pin Tussy T Logo Accesorio',
  'SWEATER ATLANTIC TSSY': 'Sweater Tussy Atlantic Tejido Hombre Cuello Redondo',
  'SWEATER WEAVES TSSY': 'Sweater Tussy Weaves Tejido Hombre Cuello Redondo',
};
const plan = data.map(p => {
  let proposed = titles[p.tn_nombre];
  if (!proposed && p.tn_nombre.startsWith('REMERA')) {
    const model = p.tn_nombre.replace(/^REMERA (OVERSIZE )?/, '').replace(/\bTSSY\b/g,'').trim().toLowerCase().replace(/\b[a-z]/g,c=>c.toUpperCase());
    proposed = `Remera Oversize Tussy ${model} Algodón Hombre`;
  }
  proposed = proposed?.replace(/\b(Hombre|Unisex)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!proposed || proposed.length > 60) throw new Error(`Revisar título: ${p.tn_nombre}: ${proposed}`);
  const actual = applied.find(a=>a.item_id===p.item_id)?.after;
  return { item_id:p.item_id, current:p.item.title, proposed:actual?.title||proposed, characters:(actual?.title||proposed).length, applied:!!actual };
});
fs.writeFileSync('meli/auditoria-variantes/titulos-propuestos.json', JSON.stringify({date:'2026-10-19',status:fullyApplied?'Aplicados y verificados en MELI':'Propuesta: sin aplicar en MELI',sources,items:plan},null,2));
const esc = x => String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link = (url,label) => `<a href="${esc(url)}">${esc(label)}</a>`;
const photoRows = data.map(p=>{
  const change=changes.find(c=>c.item_id===p.item_id);
  const groups = change ? Object.entries(Object.groupBy(p.item.variations,v=>v.attribute_combinations.find(a=>a.id==='COLOR')?.value_name||'Único')).map(([c,vs])=>{
    const ids=change.variations.find(v=>v.id===vs[0].id).picture_ids;
    return `${esc(c)}: ${ids.length} foto(s)`;
  }).join('<br>') : 'Galería coherente con el color disponible';
  return `<tr><td>${esc(p.tn_nombre)}</td><td>${change?'Corregida':'Revisada'}</td><td>${groups}</td><td>${p.item.variations.length}</td></tr>`;
}).join('');
const titleRows=plan.map(p=>`<tr><td>${link(`https://www.mercadolibre.com.ar/syi/core/modify?itemId=${p.item_id}`,p.item_id)}</td><td>${esc(p.current)}</td><td><strong>${esc(p.proposed)}</strong></td><td>${p.characters}</td></tr>`).join('');
const html=`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tussy · Revisión MELI</title>
<style>body{font:16px/1.6 system-ui,sans-serif;color:#18251e;background:#f4f5f1;margin:0}main{max-width:1140px;margin:auto;padding:48px 24px}h1{font-size:40px;line-height:1.15}h2{margin-top:48px}h3{margin-top:28px}a{color:#246244}table{border-collapse:collapse;width:100%;font-size:14px;background:white;margin:20px 0}td,th{padding:12px;text-align:left;border-bottom:1px solid #d9ded7;vertical-align:top}th{background:#e6eae3}.card{background:white;padding:24px;border-radius:14px;margin:20px 0}.badge{color:#37644b;font-weight:700}.note{color:#58645a}img{max-width:100%;border:1px solid #d9ded7}code{background:#e6eae3;padding:2px 5px}</style>
<main><p class="badge">TUSSY / MERCADO LIBRE / 19 OCTUBRE 2026</p><h1>Fotos corregidas.<br>Títulos preparados para revisión.</h1>
<div class="card"><strong>39 publicaciones · 175 variantes · 229 fotos revisadas.</strong><p>Se corrigieron las asociaciones de fotos de 14 publicaciones que reúnen 99 variantes de color y talle. Las otras 25 publicaciones tienen galerías coherentes con sus variantes. Las 39 publicaciones continúan pausadas. Las correcciones conservaron stock, precios, talles, colores y títulos.</p></div>
<h2>Qué estaba pasando con las fotos</h2><p>El script <code>meli/refotos.mjs</code> asignaba los primeros diez IDs de foto a todas las variantes. Por eso Blanco y Negro recibían la misma galería. Además, las galerías incluían colores presentes en Tiendanube pero sin variante disponible en MELI.</p><p>Se revisaron visualmente las 229 fotos y se contrastaron los colores con el catálogo actual de Tiendanube. Se separaron galerías por color usando los IDs ya existentes en MELI. En Tails se separó Negro de las versiones Snow; en Roots se separó Negro de Azul Marino. No se crearon variantes nuevas ni se eliminó stock.</p>
<h3>Ejemplo: Amberline</h3><p>Negro conserva sus seis imágenes. Blanco usa exclusivamente la foto de la remera blanca, en los cuatro talles. Tiendanube solo aporta una imagen de esa versión blanca.</p><img src="amberline-corregida.jpg" alt="Galerías corregidas: Amberline negro y blanco">
<table><thead><tr><th>Producto</th><th>Resultado</th><th>Galerías por color</th><th>Variantes</th></tr></thead><tbody>${photoRows}</tbody></table>
<h2>Cómo titula la competencia</h2><p>Se revisaron las tiendas oficiales de Bullbenny y Bomba Project en el navegador y resultados indexados de publicaciones de King of the Kongo y Narrow. La tienda de King devolvió no disponible durante la revisión; su muestra proviene de publicaciones indexadas. Es un análisis cualitativo de títulos observados, sin datos de volumen de búsqueda ni acceso a conversiones o ventas atribuibles a cada palabra.</p>
<table><tr><th>Marca</th><th>Ejemplo observado</th><th>Qué aporta para Tussy</th></tr>
<tr><td>${link(sources.bull,'Bullbenny')}</td><td>Remera Oversize Bullbenny Pacifico<br>Campera Chaqueta Bullbenny Aeronáutica Aero<br>Buzo Oversize Unisex Cuello Redondo Bullbenny Bb</td><td>Tipo y calce al comienzo; marca visible; modelo distintivo. Usa atributos funcionales cuando corresponden.</td></tr>
<tr><td>${link(sources.bomba,'Bomba Project')}</td><td>Remera Boxy Fit Argentina 2006 Bomba Project Unisex<br>Buzo Con Doble Cierre Mix Print Con Capucha Bomba Project</td><td>Detalla calce, construcción y material. Boxy fit es un corte específico: no equivale automáticamente a oversize.</td></tr>
<tr><td>${link(sources.king,'King of the Kongo')}</td><td>Remera Oversize Fit King Of The Kongo Acid Black<br>${link(sources.kingPants,'Pantalon Jean Mega Baggy Denim King Of The Kongo Sin Género')}</td><td>Conserva el modelo y suma la familia de búsqueda: remera oversize, jean, baggy. Jean/denim no corresponde al Asimov.</td></tr>
<tr><td>${link(sources.narrow,'Narrow')}</td><td>Remera Classic Tee Narrow</td><td>Ejemplo de título más corto y orientado al modelo/marca. No hace falta ocupar todo el límite con sinónimos.</td></tr></table>
<p>Las tarjetas a veces agregan talle y color al nombre visible. No hay que copiar esa concatenación como título base. La muestra también contiene errores y redundancias; su presencia no demuestra que ayuden a posicionar.</p>
<h2>Palabras a priorizar en Tussy</h2><table><tr><th>Familia</th><th>Términos principales</th><th>Términos condicionados al producto</th></tr><tr><td>Remeras</td><td>Remera, Oversize, Tussy, modelo</td><td>Algodón; estampa o brillos cuando diferencien la prenda</td></tr><tr><td>Buzos</td><td>Buzo, Oversize, Tussy, modelo</td><td>Con capucha, canguro; Hoodie como variante para evaluar</td></tr><tr><td>Camperas</td><td>Campera, Tussy, modelo</td><td>Tejida, con cierre, con capucha solo si la tiene</td></tr><tr><td>Sweaters</td><td>Sweater, Tussy, modelo, tejido</td><td>Cuello redondo; no inventar lana, cashmere o composición</td></tr><tr><td>Pantalón</td><td>Pantalón, Baggy, Tussy, Asimov</td><td>Deportivo; no jean, denim o cargo</td></tr><tr><td>Bolsos y mochila</td><td>Cartera, bandolera, bolso de viaje, mochila urbana según formato</td><td>Correa, cadena, monedero según lo visible; no afirmar cuero sin verificar material</td></tr><tr><td>Boxers</td><td>Boxer, Tussy, modelo, algodón</td><td>Unidad para distinguir de packs; no prometer composición exacta sin ficha</td></tr><tr><td>Accesorios</td><td>Gorra, camuflada, Tussy; pin, Tussy, logo</td><td>Sin palabras de género en el título</td></tr></table>
<p><strong>Son hipótesis de relevancia basadas en el catálogo y la competencia, no un ranking de palabras por búsquedas.</strong> No se midieron demanda, dificultad ni posición orgánica. Para validar: registrar visitas y conversión por publicación cuando estén activas, comparar períodos equivalentes y evitar cambiar precio, publicidad y título al mismo tiempo.</p>
<h2>Criterio propuesto</h2><p>Usar <strong>tipo + calce + Tussy + modelo + atributo útil</strong>. Incluir Tussy una vez y normalizar Tssy a Tussy. Mantener los modelos para conservar identidad. Se eliminan Hombre y Unisex de todos los títulos propuestos por decisión de Alan. En remeras se conserva Algodón. El atributo estructurado Género de MELI sigue con su valor actual: quitar una palabra del título no modifica ese filtro.</p><p>La ${link(sources.meli,'guía oficial de Mercado Libre')} recomienda producto, marca, modelo y especificaciones identificadoras. No poner colores o talles como parte fija en títulos con varias variantes; no incluir marcas competidoras, ofertas, envío gratis o listas de sinónimos. El título ayuda a describir la relevancia, pero no garantiza una posición: las fotos, atributos completos y desempeño comercial también requieren atención.</p>
<h2>Los 39 títulos propuestos</h2><p class="note">Sin aplicar en MELI. Todos tienen 60 caracteres o menos. Se recomienda revisar la denominación comercial de Carteras/Bandoleras antes de aprobar el lote. No se cambiaron nombres en Tiendanube.</p><table><thead><tr><th>Publicación</th><th>Actual</th><th>Propuesta</th><th>Caracteres</th></tr></thead><tbody>${titleRows}</tbody></table>
<h2>Registro</h2><p>Snapshots antes y después, plan aplicado y verificación final están guardados en <code>meli/auditoria-variantes/</code>. Los colores con pocas fotos quedan con las imágenes correctas disponibles, aunque eso reduzca su galería. No se generaron fotos ni se mezclaron colores para rellenarla.</p></main></html>`;
let finalHtml=html;
if(fullyApplied)finalHtml=finalHtml.replace('Títulos preparados para revisión.','Títulos y género actualizados en MELI.').replace('Los 39 títulos propuestos','Los 39 títulos aplicados').replace('Sin aplicar en MELI. Todos tienen 60 caracteres o menos. Se recomienda revisar la denominación comercial de Carteras/Bandoleras antes de aprobar el lote. No se cambiaron nombres en Tiendanube.','Aplicados y verificados en MELI. Todos tienen 60 caracteres o menos y no contienen Hombre ni Unisex. Se cambió a Sin género el atributo de las 25 prendas de uso general (remeras, buzos, camperas, pantalón y sweaters). Los cuatro modelos de boxer conservan el género de su categoría. Las 39 publicaciones siguen pausadas; fotos, variantes, stock y precios conservados. No se cambiaron nombres en Tiendanube.').replace('El atributo estructurado Género de MELI sigue con su valor actual: quitar una palabra del título no modifica ese filtro.','El atributo estructurado Género de las 25 prendas de uso general también se actualizó a Sin género.').replace('<h2>Registro</h2>','<h2>Catálogo de Tiendanube</h2><p>Se compararon 362 productos con las 39 publicaciones reales de MELI. <a href="faltantes-tiendanube.html">Ver productos recientes y listado completo de faltantes</a>.</p><h2>Registro</h2>');
fs.writeFileSync('meli/auditoria-variantes/revision-meli.html',finalHtml);
console.log('39 títulos preparados; máximo',Math.max(...plan.map(p=>p.characters)),'caracteres');
