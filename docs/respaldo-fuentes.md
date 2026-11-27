# Respaldo crudo de las fuentes viejas de venta

Cada archivo es el JSON **tal como lo devolvió la API de origen**, sin normalizar
ni interpretar: una venta por línea (formato NDJSON). La idea es poder
reconstruir cualquier cosa más adelante sin depender de que la fuente siga viva.

Se generan con `node scripts/respaldo-fuentes.js dragonfish|woo|tiendanube`.
Al lado de cada `.ndjson` hay un `.cursor` con lo último que se bajó: el script
es resumible, si se corta se vuelve a correr y sigue de ahí.

Esta carpeta está en `.gitignore` a propósito — son cientos de megas y contienen
datos de clientes (nombre, dirección, mail, teléfono). **No subir a git.**

## Por qué existe esto

Porque La Plata ya se perdió. Su WooCommerce vivía en `localestussy.wnpower.host`,
se dio de baja el dominio y con él la base. De esa tienda no quedó nada propio
anterior a marzo de 2026: ni en la tabla `ventas`, ni en las planillas viejas de
Apps Script (`VentasDiarias` / `VentasDetalle`, que arrancan recién en 2026), ni
en ningún volcado en disco.

**Está cerrado, no hay que volver a intentarlo.** En nov-2026 se le reclamó a
wnpower y contestaron que se borró todo: no tienen backup. Lo único que se
recuperó fue la facturación desde ARCA (`scripts/arca-historico.js`), que da el
monto y la cantidad de comprobantes pero no qué producto se vendió, y que para
La Plata viene con dos advertencias importantes anotadas en el encabezado de ese
script: la fecha es la de emisión y no la de la venta (facturaban en lotes hasta
que pasaron al ERP), y lo facturado es ~53% de lo vendido.

El detalle de producto de La Plata entre ago-2023 y feb-2026 no existe en ningún
lado. Es la razón por la que esta carpeta existe para las otras fuentes.

Las otras dos fuentes se apagan también: Palermo dejó Woo el 19-ago-2026 y
Dragonfish se da de baja en nov-2026, cuando el último local (Córdoba) pasó al
Tussy ERP. Mientras los servidores sigan contestando, esto se baja. Después, no.

## Qué hay en cada archivo

| Archivo | Fuente | Qué contiene |
|---|---|---|
| `woo/palermo.ndjson` | API de WooCommerce de Palermo | órdenes completas con renglones, cliente, medio de pago y envío |
| `dragonfish/dot.ndjson` | `api.Dragonfish/Facturaagrupada` de Dot | facturas con renglones y `ValoresDetalle` (un cobro por medio) |
| `dragonfish/abasto.ndjson` | ídem Abasto | ídem |
| `dragonfish/cordoba.ndjson` | ídem Córdoba | ídem |
| `tiendanube/tiendanube.ndjson` | API de Tiendanube | órdenes con `products`, `payment_details`, envío y descuentos |

No hay archivo de La Plata: no hay de dónde sacarlo.

## Cuándo arranca cada historia

Medido contra cada API, no estimado. Lo mismo está en `FUENTE_DESDE`
(`lib/fuentes.js`), que es lo que evita pedirle a una fuente días que no tiene.

| Fuente | Primera venta |
|---|---|
| Woo Palermo | 2023-07-07 |
| Dragonfish Dot | 2025-07-25 (las dos primeras facturas son pruebas de $11; la venta real arranca en agosto) |
| Dragonfish Abasto | 2025-11-06 |
| Dragonfish Córdoba | 2025-12-02 |
| Tiendanube | 2024-05-14, 15:33 |
| La Plata (ARCA) | 2023-08-11 |

## Trampas de cada API, por si hay que volver a bajar esto

**Dragonfish** no sabe filtrar por fecha: sólo ordena y pagina. Con
`sort=Fecha` ascendente desde la página 1 baja toda la historia en orden. No
tiene página vacía: cuando te pasás del final tira **404**, que acá se usa como
señal de fin. Los servidores de los locales son lentos y Córdoba devuelve 530
seguido (Cloudflare del lado de ellos), así que todo va con reintentos.

**Tiendanube** tiene un techo de **10.000 registros de offset**: `page × per_page`
no puede pasar de ahí o contesta `422 Query exceeds max allowed limit of 10000`.
Un año entero no se puede paginar completo (2024 tiene 13.733 órdenes), así que
se baja mes por mes. Ojo con el otro 404: pedir un mes sin ventas devuelve
`404 Last page is 0`, igual que pedir una página que no existe — los dos casos
son indistinguibles por el status, así que un 404 nunca se puede leer como error.

**WooCommerce** sí filtra por fecha server-side y pagina normal. Se baja mes por
mes con `status=any` (a diferencia de la ingesta, que pide sólo
`completed,processing`: el respaldo se guarda todo, incluidas canceladas).

**El mes en curso puede dejar una línea repetida.** Las tres APIs paginan por
offset, así que si entra una venta nueva mientras se recorren las páginas, un
registro se corre de lugar y sale dos veces. En el respaldo de Tiendanube del
26-nov-2026 pasó una vez (la orden 2111517919). No es un error del archivo: al
leerlo, deduplicar por `id` y listo. Los meses cerrados no tienen este problema
porque ya no entran ventas con esa fecha.

## Verificar un respaldo

Un respaldo sin verificar no es un respaldo. Lo mínimo es contar líneas, ids
únicos y meses vacíos:

```bash
node -e '
const fs=require("fs"), rl=require("readline").createInterface({input:fs.createReadStream(process.argv[1])});
let n=0, m=new Map(); const ids=new Set();
rl.on("line", l => { if(!l.trim()) return; n++; const o=JSON.parse(l);
  ids.add(String(o.id)); const f=String(o.date_created||o.created_at||"").slice(0,7); if(f) m.set(f,(m.get(f)||0)+1); });
rl.on("close", () => console.log(n+" lineas, "+ids.size+" ids unicos, "+m.size+" meses"));
' respaldos/woo/palermo.ndjson
```

Lo que dio la corrida del 26-nov-2026, para comparar:

| Archivo | Líneas | Únicas | Rango | Meses | Peso |
|---|---|---|---|---|---|
| `woo/palermo.ndjson` | 42.253 | 42.253 | 2023-07-07 → 2026-08-18 | 38 | 163 MB |
| `tiendanube/tiendanube.ndjson` | 54.112 | 54.111 | 2024-05-14 → 2026-11-26 | 31 | 301 MB |
| `dragonfish/dot.ndjson` | 12.942 | 12.942 | 2025-07-25 → 2026-11-18 | 17 | 43 MB |
| `dragonfish/abasto.ndjson` | 12.874 | 12.874 | 2025-11-06 → 2026-11-18 | 13 | 45 MB |
| `dragonfish/cordoba.ndjson` | 6.913 | 6.913 | 2025-12-02 → 2026-11-19 | 12 | 23 MB |

Ningún mes vacío en ninguno. La línea de diferencia en Tiendanube es la repetida
del mes en curso explicada arriba. Palermo cierra el 18-ago-2026 y los Dragonfish
el 18/19-nov-2026 porque son los días en que esos locales pasaron al ERP.

### Cruzado contra la tabla `ventas`

Dos caminos distintos desde la misma fuente tienen que dar el mismo número. Las
facturas únicas del respaldo contra las órdenes en `ventas` con `sistema =
'Dragonfish'`:

| Local | Respaldo | En `ventas` | Diferencia |
|---|---|---|---|
| Córdoba | 6.913 | 6.913 | **0** |
| Abasto | 12.874 | 12.873 | 1 |
| Dot | 12.942 | 12.938 | 4 |

Las cinco de diferencia son facturas vacías (`Total` 0, sin `FacturaDetalle` ni
`ValoresDetalle`): el respaldo guarda todo crudo y la ingesta las saltea bien,
porque no hay ninguna línea de venta que cargar. No falta nada.
