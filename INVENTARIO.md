# Inventario de tussy-app

> Relevamiento al 6 de octubre de 2026. Generado leyendo el código, las migraciones
> y la base de datos en producción. Los conteos de filas son reales, no estimados.

**Stack:** Vercel Functions (Node) + Neon Postgres + React/Vite (SPA) + PWA con notificaciones push.
**Deploy:** `git push origin main`. Build: `cd web && npm ci && npm run build`.

---

## 1 · Módulos y pantallas

La app es una SPA con sidebar agrupado en dos secciones. Cada pantalla pega contra
una o más *actions* de los endpoints de `/api`.

### Operación

| pantalla | archivo | quién la ve | qué hace |
|---|---|---|---|
| **Inicio** | `Home.jsx` | todos | Tablero del día: ventas por local, comparación contra el mes anterior, serie histórica y proyección de cierre de mes. |
| **Alertas** | `Alertas.jsx` | solo admin | Seis reglas comerciales que corren todas las noches: productos sin costo, productos que pierden plata, los que venden en locales y no están en la web, drops nuevos sin pauta, campañas gastando sin vender y campañas fatigadas. La lógica vive en `lib/alertas.js`. |
| **Ventas** | `Ventas.jsx` | todos | Ventas por día y por local, con filtro de período y comparación. |
| **Pedidos** | `Pedidos.jsx` | todos (margen solo admin) | Operación por operación con su desglose de rentabilidad: mercadería, IVA, IIBB, impuesto al cheque y comisiones reales de cobro. Filtro por período y por local. |
| **Productos** | `Productos.jsx` | solo admin | Top productos, categorías y variantes por período. |
| **Carga** | `Carga.jsx` | solo admin | Subida mensual de los reportes de MercadoPago Point y Tiendanube en `.xlsx`. El navegador parsea el archivo y manda solo las columnas necesarias. |

### Administración

| pantalla | archivo | quién la ve | qué hace |
|---|---|---|---|
| **Finanzas** | `Finanzas.jsx` | **solo socios** | Vista de lectura del flujo del mes. Para el admin está redirigida a Cajas porque es redundante. |
| **Cajas** | `Cajas.jsx` | solo admin | Reemplazo de los Excels "Finanzas Tussy Definitivo" y "Finanzas_Shato_v2". Ingresos y egresos en efectivo, con las marcas **tussy** y **shato** siempre separadas. Carga rápida con categorías como botones. |
| **Socios** | `Socios.jsx` | solo admin | Pozos declarados repartidos por porcentaje y cuenta corriente de cada socio (retiros, gastos, aportes), más el tablero de retiros mes a mes. Un retiro en efectivo impacta la caja con la fila linkeada. |
| **Deuda Shato** | `DeudaShato.jsx` | solo admin | Ledger de préstamos cruzados Shato ↔ Tussy. Balance = Shato − Tussy. |
| **RRHH** | `RRHH.jsx` | solo admin | Legajos de empleados y asistencia día a día. La marca diaria la cargan los encargados en el ERP de locales y llega por webhook; acá se mira y se corrige por excepción. |
| **Rentabilidad** | `Rentabilidad.jsx` | todos | La pantalla más grande del sistema (1.376 líneas). Rentabilidad por producto, por negocio y escenarios. |
| **Contabilidad** | `Contabilidad.jsx` | solo admin | Posición de IVA, control de facturación, gastos por rubro y conciliación de transferencias de MercadoPago contra facturas recibidas. |

### Backend

| endpoint | líneas | qué hace |
|---|---|---|
| `api/metricas.js` | 2.981 | El núcleo. 40 *actions*: ingesta, cierre diario, feed de pedidos, rentabilidad, contabilidad, inventario, alertas, proyecciones, carga de reportes. También aloja los tres crons. |
| `api/cajas.js` | 367 | Cajas, socios y deuda Shato. 14 *actions*. |
| `api/rrhh.js` | 134 | Legajos y asistencias. 7 *actions*. |
| `api/telegram.js` | 291 | Webhook del bot. Responde consultas con IA y ejecuta cambios de pauta con autorización. |
| `api/auth.js` | 34 | Login. Devuelve un token HMAC firmado. |
| `api/tussy-erp/ventas.js` | 98 | Webhook: cada venta confirmada de Palermo y La Plata. |
| `api/tussy-erp/rrhh.js` | 83 | Webhook: marcas de asistencia de los encargados. |
| `api/proxy.js` · `proxy-operaciones.js` | 39 · 71 | Puentes hacia los Apps Script heredados. |
| `api/resumen-diario.js` | 34 | Suscripciones a notificaciones push. El resumen que le daba nombre ya no existe; la ruta se conserva porque las PWA instaladas apuntan ahí. |

### Librerías compartidas

`lib/alertas.js` (reglas comerciales) · `lib/fuentes.js` (fetchers de Woo, Tiendanube y Dragonfish) · `lib/agente.js` (capa de IA del bot) · `lib/arca.js` (web service de AFIP) · `lib/mercadopago.js` · `lib/stock.js` · `lib/rentabilidad.js` (modelo de margen por operación) · `lib/reportes.js` · `lib/meta.js` · `lib/bancos.js` · `lib/costeo.js` · `lib/normalizar.js` · `lib/auth.js`

### Tareas programadas

| cron | frecuencia | qué hace |
|---|---|---|
| `/api/cron/ingesta` | cada 5 minutos | Trae ventas de las 6 fuentes, sincroniza pagos de MercadoPago cada 20 min, manda notificaciones push de ventas nuevas y costea modelos nuevos. |
| `/api/cron/cierre` | 00:05 ARG | Cierre del día anterior, foto de inventario, sincronización con ARCA, reingesta de 7 días, métricas de Meta, pagos de MP y alertas comerciales. |
| `/api/cron/semanal` | lunes 09:00 ARG | Resumen semanal. |

---

## 2 · Base de datos

**34 tablas en Neon Postgres.** Dato importante: **solo hay 2 claves foráneas declaradas.**
El resto de las relaciones son por convención, no las fuerza la base.

### Relaciones declaradas

```
asistencias.empleado_id        → empleados.id
socios_movimientos.caja_mov_id → caja_movimientos.id
```

### Relaciones de hecho (por convención, sin FK)

```
ventas.orden_id  ←→ cobros.orden_id ←→ clientes_tn.orden_id   (local + orden_id)
ventas.producto_norm            → costos_producto.producto
pagos_mp.orden_id               → cobros.orden_id              (solo canal online)
cobros.local / ventas.local     → 'Tiendanube' | Palermo | La Plata | Abasto | Dot | Córdoba
caja_movimientos.marca          → 'tussy' | 'shato'
socios_movimientos.socio        → socios.nombre
meta_insights.cuenta            → cuenta publicitaria de Meta
```

### Claves únicas

```
asistencias            (empleado_id, fecha)
comprobantes_emitidos  (tipo, punto_venta, numero)
comprobantes_recibidos (cuit_emisor, tipo, punto_venta, numero)
```

### Detalle de cada tabla

### `arca_cursor` — 20 filas
| columna | tipo | |
|---|---|---|
| punto_venta | integer | PK |
| tipo | integer | PK |
| ultimo | bigint |  |

### `arca_ta` — 1 fila
| columna | tipo | |
|---|---|---|
| servicio | text | PK |
| token | text |  |
| firma | text |  |
| expira | timestamptz |  |

### `asistencias` — 5 filas
fecha: 2026-09-11 → 2026-09-23
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| empleado_id | bigint |  |
| fecha | date |  |
| estado | text |  |
| minutos_tarde | integer |  |
| motivo | text |  |
| marcado_por | text |  |
| origen | text |  |
| creado_en | timestamptz |  |

### `caja_movimientos` — 1.303 filas
fecha: 2026-03-01 → 2026-10-05
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| marca | text |  |
| fecha | date |  |
| tipo | text |  |
| categoria | text |  |
| detalle | text |  |
| monto | numeric |  |
| usuario | text |  |
| origen | text |  |
| creado_en | timestamptz |  |
| medio | text |  |

### `clientes_tn` — 12.668 filas
fecha: 2026-02-01 → 2026-10-06
| columna | tipo | |
|---|---|---|
| orden_id | text | PK |
| cliente_id | bigint |  |
| fecha | date |  |
| total | numeric |  |

### `cobros` — 21.782 filas
fecha: 2026-06-01 → 2026-10-06
| columna | tipo | |
|---|---|---|
| fecha | date |  |
| local | text | PK |
| orden_id | text | PK |
| item | integer | PK |
| medio | text |  |
| detalle | text |  |
| monto | numeric |  |
| sistema | text |  |
| gateway | text |  |
| cuotas | integer |  |

### `completitud_ok` — 1 fila
mes: 2026-07 → 2026-07
| columna | tipo | |
|---|---|---|
| mes | text | PK |
| clave | text | PK |
| confirmado_por | text |  |
| confirmado_en | timestamptz |  |

### `comprobantes_emitidos` — 29.657 filas
fecha: 2026-02-01 → 2026-10-05
| columna | tipo | |
|---|---|---|
| id | integer | PK |
| fecha | date |  |
| tipo | integer |  |
| punto_venta | integer |  |
| numero | bigint |  |
| doc_tipo | integer |  |
| doc_nro | bigint |  |
| receptor | text |  |
| neto | numeric |  |
| iva | numeric |  |
| otros_tributos | numeric |  |
| total | numeric |  |
| cae | text |  |
| fuente | text |  |
| cargado_en | timestamptz |  |

### `comprobantes_recibidos` — 837 filas
fecha: 2026-02-01 → 2026-09-28
| columna | tipo | |
|---|---|---|
| id | integer | PK |
| fecha | date |  |
| tipo | integer |  |
| punto_venta | integer |  |
| numero | bigint |  |
| cuit_emisor | bigint |  |
| emisor | text |  |
| neto | numeric |  |
| iva | numeric |  |
| otros_tributos | numeric |  |
| total | numeric |  |
| cargado_en | timestamptz |  |

### `config_negocio` — 20 filas
| columna | tipo | |
|---|---|---|
| clave | text | PK |
| valor | numeric |  |
| descripcion | text |  |
| actualizado_en | timestamptz |  |

### `costos_producto` — 424 filas
creado_en: 2026-07-30 → 2026-10-01
| columna | tipo | |
|---|---|---|
| producto | text | PK |
| costo | numeric |  |
| vigente_desde | date | PK |
| creado_en | timestamptz |  |
| origen | text |  |
| estampa | numeric |  |

### `deuda_shato` — 767 filas
fecha: 2023-09-19 → 2026-09-25
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| fecha | date |  |
| lado | text |  |
| detalle | text |  |
| kilos | numeric |  |
| precio | numeric |  |
| monto | numeric |  |
| usuario | text |  |
| origen | text |  |
| creado_en | timestamptz |  |

### `efectivo_locales` — 0 filas
| columna | tipo | |
|---|---|---|
| local | text | PK |
| fecha | date | PK |
| saldo | numeric |  |
| declarado_por | text |  |

### `egresos_mp` — 7.186 filas
fecha: 2026-07-01 → 2026-08-31
| columna | tipo | |
|---|---|---|
| id | text | PK |
| fecha | date |  |
| contraparte | text |  |
| cuit | bigint |  |
| monto | numeric |  |
| detalle | text |  |
| cargado_en | timestamptz |  |
| entrada | boolean |  |

### `empleados` — 23 filas
creado_en: 2026-09-08 → 2026-09-23
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| nombre | text |  |
| local | text |  |
| puesto | text |  |
| cuil | text |  |
| telefono | text |  |
| fecha_ingreso | date |  |
| estado | text |  |
| notas | text |  |
| origen | text |  |
| creado_en | timestamptz |  |

### `gastos_fijos` — 130 filas
| columna | tipo | |
|---|---|---|
| local | text | PK |
| vigente_desde | text | PK |
| concepto | text | PK |
| monto | numeric |  |
| actualizado_en | timestamptz |  |
| estimado | boolean |  |

### `gastos_mes` — 5 filas
mes: 2026-06 → 2026-08
| columna | tipo | |
|---|---|---|
| mes | text | PK |
| local | text | PK |
| concepto | text | PK |
| monto | numeric |  |
| actualizado_en | timestamptz |  |

### `impuestos_mes` — 6 filas
mes: 2026-06 → 2026-08
| columna | tipo | |
|---|---|---|
| mes | text | PK |
| concepto | text | PK |
| monto | numeric |  |
| nota | text |  |
| actualizado_en | timestamptz |  |

### `ipc_mes` — 4 filas
mes: 2026-03 → 2026-06
| columna | tipo | |
|---|---|---|
| mes | text | PK |
| pct | numeric |  |

### `meta_insights` — 2.627 filas
fecha: 2026-02-01 → 2026-10-06
| columna | tipo | |
|---|---|---|
| fecha | date | PK |
| campania_id | text | PK |
| cuenta | text |  |
| campania | text |  |
| gasto | numeric |  |
| impresiones | bigint |  |
| clicks | integer |  |
| compras | integer |  |
| valor_compras | numeric |  |

### `metas_mes` — 1 fila
mes: 2026-08 → 2026-08
| columna | tipo | |
|---|---|---|
| mes | text | PK |
| local | text | PK |
| monto | numeric |  |

### `mix_pagos` — 18 filas
mes: 2026-06 → 2026-08
| columna | tipo | |
|---|---|---|
| mes | text | PK |
| local | text | PK |
| bruto | numeric |  |
| neto | numeric |  |
| ops | integer |  |
| costo_pct | numeric |  |
| mix | jsonb |  |
| actualizado_en | timestamptz |  |

### `movimientos_banco` — 207 filas
fecha: 2026-07-01 → 2026-08-31
| columna | tipo | |
|---|---|---|
| id | text | PK |
| origen | text |  |
| fecha | date |  |
| descripcion | text |  |
| contraparte | text |  |
| cuit | bigint |  |
| monto | numeric |  |
| comprobante | text |  |
| categoria | text |  |
| cargado_en | timestamptz |  |

### `pagos_mp` — 4.311 filas
fecha: 2026-08-18 → 2026-10-06
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| fecha | date |  |
| hora | text |  |
| local | text |  |
| monto | numeric |  |
| neto | numeric |  |
| comision | numeric |  |
| financiacion | numeric |  |
| retenciones | numeric |  |
| medio | text |  |
| cuotas | integer |  |
| estado | text |  |
| pos | text |  |
| orden_id | text |  |
| crudo | jsonb |  |
| creado_en | timestamptz |  |

### `proveedores` — 144 filas
| columna | tipo | |
|---|---|---|
| cuit | bigint | PK |
| nombre | text |  |
| rubro | text |  |

### `saldos_cuenta` — 14 filas
fecha: 2026-07-31 → 2026-08-31
| columna | tipo | |
|---|---|---|
| cuenta | text | PK |
| fecha | date | PK |
| saldo | numeric |  |

### `socios` — 3 filas
| columna | tipo | |
|---|---|---|
| nombre | text | PK |
| porcentaje | numeric |  |
| activo | boolean |  |

### `socios_movimientos` — 81 filas
fecha: 2026-03-01 → 2026-10-05
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| fecha | date |  |
| socio | text |  |
| tipo | text |  |
| descripcion | text |  |
| monto | numeric |  |
| caja_mov_id | bigint |  |
| usuario | text |  |
| origen | text |  |
| creado_en | timestamptz |  |

### `stock` — 179.688 filas
fecha: 2026-07-30 → 2026-10-06
| columna | tipo | |
|---|---|---|
| fecha | date |  |
| local | text |  |
| producto_norm | text |  |
| sku | text |  |
| color | text |  |
| talle | text |  |
| cantidad | numeric |  |
| precio | numeric |  |
| creado_en | timestamptz |  |

### `stock_estado` — 345 filas
fecha: 2026-07-30 → 2026-10-06
| columna | tipo | |
|---|---|---|
| fecha | date | PK |
| local | text | PK |
| estado | text |  |
| filas | integer |  |
| unidades | numeric |  |
| error | text |  |
| actualizado_en | timestamptz |  |

### `sync_estado` — 1.378 filas
fecha: 2026-03-01 → 2026-10-06
| columna | tipo | |
|---|---|---|
| fecha | date | PK |
| local | text | PK |
| estado | text |  |
| intentos | integer |  |
| ultimo_error | text |  |
| actualizado_en | timestamptz |  |

### `telegram_historial` — 1 fila
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| mensajes | jsonb |  |
| actualizado_en | timestamptz |  |

### `telegram_pendiente` — 1 fila
creado_en: 2026-09-21 → 2026-09-21
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| accion | jsonb |  |
| creado_en | timestamptz |  |

### `ventas` — 87.089 filas
fecha: 2026-03-01 → 2026-10-06
| columna | tipo | |
|---|---|---|
| id | bigint | PK |
| fecha | date |  |
| local | text |  |
| sistema | text |  |
| orden_id | text |  |
| producto | text |  |
| sku | text |  |
| color | text |  |
| talle | text |  |
| cantidad | numeric |  |
| precio_unit | numeric |  |
| total | numeric |  |
| creado_en | timestamptz |  |
| hora | text |  |
| producto_norm | text |  |

---

## 3 · Integraciones externas

**No hay Make, Zapier ni n8n.** Busqué en todo el código y no aparecen. Toda la
integración es directa, por API, desde las funciones de Vercel.

Los únicos seis dominios externos a los que llama el sistema:

| servicio | para qué | credencial | estado |
|---|---|---|---|
| **Tiendanube** `api.tiendanube.com` | Catálogo (productos, stock, publicado) y órdenes del canal online. | `TN_ACCESS_TOKEN`, `TN_USER_ID` | Activo. El token no tiene permisos de envíos ni de sucursales, así que el retiro en local hay que configurarlo a mano en el panel. |
| **Meta / Facebook** `graph.facebook.com` | Campañas, conjuntos, anuncios, creativos, catálogo de productos y métricas de pauta. | `META_TOKEN` | Activo. **El token vence el 17 de octubre de 2026** — hay que renovarlo. |
| **MercadoPago** `api.mercadopago.com` | Pagos de Point (locales) y de checkout (web), con su costo financiero real por operación. | `MP_ACCESS_TOKEN` | Activo. Checkout online desde el 17-sep-2026. |
| **AFIP / ARCA** `wsaa.afip.gov.ar` · `servicios1.afip.gov.ar` | Comprobantes emitidos, para la posición de IVA. | `ARCA_CERT`, `ARCA_KEY` | Activo, corre en el cierre nocturno. |
| **Telegram** `api.telegram.org` | Bot de consultas y de autorización de cambios. | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | Activo, un solo chat autorizado. |
| **Anthropic** | Capa de IA del bot (`lib/agente.js`). | `ANTHROPIC_API_KEY` | Activo. |

### Fuentes de venta (seis canales)

| canal | sistema | cómo entra |
|---|---|---|
| Tiendanube | web | pull por API, cada 5 minutos |
| **Palermo**, **La Plata** | Tussy ERP (Supabase) | **push** por webhook `/api/tussy-erp/ventas`, en el momento del cobro |
| **Abasto**, **Dot**, **Córdoba** | Dragonfish | pull por API, cada 5 minutos |

Palermo y La Plata migraron de WooCommerce al ERP propio el **19 de agosto de 2026**.
Las credenciales de Woo siguen en el entorno y responden 200 con lista vacía: **cero
filas de Woo no es un error**, es que ya no se usa.

### Puentes heredados

Tres Apps Script de Google (`APPS_SCRIPT_URL`, `APPS_SCRIPT_URL_OPERACIONES`,
`APPS_SCRIPT_URL_SHATO`) que sobreviven para las suscripciones push y algunas
operaciones. Los archivos `.gs` están versionados en la raíz del repo.

### Nota sobre SKU

Conviven **dos numeraciones**: Dragonfish usa códigos propios (`0000116`) y el ERP
de locales comparte numeración con la web (`50121`). Para cruzar un producto entre
canales hay que usar **SKU entre Tiendanube, Palermo y La Plata**, y **nombre para
Abasto, Dot y Córdoba**.

---

## 4 · Roles y usuarios

Autenticación por **token HMAC firmado**, sin estado en el servidor: el token lleva
usuario, rol y nombre, y la firma garantiza que lo emitió este backend. Rotar
`AUTH_SECRET` invalida todas las sesiones al instante.

**Hay exactamente tres usuarios, definidos en código** (`api/auth.js`), con la
contraseña en variables de entorno:

| usuario | rol | nombre | contraseña |
|---|---|---|---|
| `alan` | **admin** | Alan | `PASS_ALAN` |
| `fede` | socio | Federico | `PASS_FEDE` |
| `nico` | socio | Nicolas | `PASS_NICO` |

### Qué ve cada rol

| | admin | socio |
|---|---|---|
| Inicio, Ventas, Pedidos, Rentabilidad | ✓ | ✓ |
| Margen por operación en Pedidos | ✓ | ✗ |
| Alertas, Productos, Carga | ✓ | ✗ |
| Cajas, Socios, Deuda Shato, RRHH, Contabilidad | ✓ | ✗ |
| Finanzas | ✗ (redirige a Cajas) | ✓ |

Pedro, el tercer socio, **no tiene usuario** aunque figura en la tabla `socios` con
12,5%. En el entorno hay además contraseñas sin usar en el código
(`PASS_BENJAMIN`, `PASS_MARIANELA`, `PASS_NOAH`, `PASS_PABLO`, `PASS_RAMIRO`,
`PASS_SEBASTIAN`): son restos de una versión anterior.

Los webhooks del ERP usan un secreto compartido aparte (`TUSSY_ERP_SECRET`), y los
crons otro (`CRON_SECRET`).

---

## 5 · Lo incompleto y lo que casi no se usa

### Tablas vacías o casi

| tabla | filas | situación |
|---|---|---|
| `efectivo_locales` | **0** | Nunca se usó. Hay una *action* (`guardarEfectivoLocal`) y la pantalla para cargarlo, pero no entró un solo dato. |
| `telegram_historial` | 1 | El bot funciona pero no deja historial real. |
| `telegram_pendiente` | 1 | Una sola autorización pendiente, del 21-sep. |
| `completitud_ok` | 1 | El control de completitud mensual se confirmó una vez (julio). |
| `metas_mes` | 1 | Se cargó una meta, en agosto. La proyección contra meta prácticamente no se usa. |
| `arca_ta` | 1 | Normal: es el ticket de acceso de AFIP, se renueva solo. |
| `socios` | 3 | Correcto, pero **solo cubre Tussy**. Shato reparte entre Fede, Nico y **Gonza** y eso no está modelado en ningún lado. |
| `asistencias` | **5** | El módulo de RRHH está construido entero pero **la asistencia casi no se carga**: 5 marcas en un mes, todas de septiembre. Los encargados no lo están usando. |
| `ipc_mes` | 4 | Cargado hasta junio. El ajuste por inflación quedó desactualizado. |

### Datos que se cortaron

| tabla | último dato | problema |
|---|---|---|
| `egresos_mp` | **31-ago-2026** | Hace más de un mes que no entra. Alimenta la conciliación de Contabilidad. |
| `movimientos_banco` | **31-ago-2026** | Ídem. Se carga a mano desde el extracto; nadie lo subió en septiembre. |
| `saldos_cuenta` | 31-ago-2026 | Ídem. |
| `mix_pagos`, `gastos_mes`, `impuestos_mes` | **agosto 2026** | Los tres se cargan mensualmente y **falta septiembre**. Sin `mix_pagos` el costo financiero de los locales se estima peor. |

### Deuda funcional

**`Finanzas.jsx` es redundante con Cajas.** Sobrevive solo para que los socios vean
algo; para el admin redirige. Hay dos pantallas que muestran lo mismo con distinto código.

**Las alertas cruzan por nombre normalizado, no por SKU.** Eso genera falsos positivos:
venía marcando "Campera Brickell" y "Remera Tail" como ausentes de la web cuando sí
estaban, con otro nombre pero el mismo SKU. Ahora que el SKU está al 100% en los seis
canales, conviene reescribir el cruce.

**Sin claves foráneas.** Solo 2 de las ~12 relaciones reales están declaradas. Un
borrado en `empleados` o `caja_movimientos` está protegido; todo lo demás puede quedar
huérfano sin que la base avise.

**`api/metricas.js` tiene 2.981 líneas y 40 acciones.** Es el archivo que concentra
casi todo el backend. Funciona, pero cualquier cambio ahí toca un archivo donde
conviven la ingesta, la contabilidad, la rentabilidad y los crons.

**`Rentabilidad.jsx` tiene 1.376 líneas y `Contabilidad.jsx` 1.119.** Son las dos
pantallas más grandes y las más difíciles de modificar.

### Pendientes conocidos del negocio

- **Buzo Castle** y **Remera Sample** venden fuerte en locales y no están cargados en la web.
- El **token de Meta vence el 17 de octubre**.
- El **retiro en local** solo está habilitado en La Plata. Habilitarlo en Palermo, Abasto, Dot y Córdoba no requiere código, pero el token de Tiendanube no tiene permisos para hacerlo por API.
