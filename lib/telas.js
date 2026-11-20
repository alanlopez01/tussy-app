// La tela que consumió Shato, leída del sistema de producción (KALYZ).
//
// EL PROBLEMA: en la Deuda Shato de esta app, el lado "tussy" (la tela que
// Tussy le carga a Shato: kilos × precio) se cargaba a mano y se cortó el
// 20-ago-2026. Los pagos de Shato siguieron cargándose, así que el balance
// quedó corrido: faltan tres meses de tela.
//
// LA SOLUCIÓN, la misma que con los comprobantes recibidos (lib/kalyz.js): no
// se carga a mano ni se arma un segundo sistema. La tela ya está medida en
// producción, corte por corte, y de ahí se lee.
//
// LA REGLA, calcada de la migración 0271 de KALYZ («la tela de Shato desde
// tussy-app»), para que las dos cuentas den lo mismo:
//   · Hasta el último cargo a mano de esta app, la tela la dice esta app.
//     Desde el día SIGUIENTE la dicen los cortes, por la fecha del corte.
//     Así ningún corte se cobra dos veces, y si mañana alguien carga tela a
//     mano con fecha posterior, el límite se mueve solo y los cortes que
//     quedan tapados desaparecen de acá.
//   · Un consumo sin importe guardado se valúa al precio de transferencia de
//     su tela (el de la tela o el de su tipo).
//   · Sin precio de transferencia, debe CERO y lo dice en el detalle. No se
//     inventa un precio.
//
// POR QUÉ UNA TABLA APARTE Y NO deuda_shato: KALYZ importa deuda_shato cada
// hora y usa el último cargo de tela como límite para no contar los cortes dos
// veces. Si esta app escribiera la tela ahí, estaría moviendo el límite con el
// que KALYZ se calcula a sí misma. La tela derivada vive separada, deuda_shato
// queda siendo lo que se carga a mano, y ninguna de las dos cuentas pisa a la
// otra.
//
// Necesita KALYZ_DATABASE_URL con permiso de lectura sobre el consumo de tela.
// Hoy el usuario tussy_app_lectura sólo ve core.comprobantes_recibidos: hasta
// que el permiso exista, esto se retira solo y lo dice.

const { cadenaConexionKalyz } = require("./kalyz");

// Igual que en los recibidos: la sociedad es "tussy_sa". "tussy" es la marca y
// con ese código la consulta devuelve cero filas sin error.
const SOCIEDAD_ACREEDORA = "shato";
const SOCIEDAD_DEUDORA = "tussy_sa";

// Si en esta app nunca se cargó tela a mano no hay límite y entran todos los
// cortes. En la práctica el límite es el 2026-08-20.
async function limiteCargaManual(sql) {
  const [f] = await sql`SELECT max(fecha)::text AS hasta FROM deuda_shato WHERE lado = 'tussy'`;
  return f?.hasta || null;
}

// El camino bueno: la vista que expone el consumo de Shato ya valuado, sin
// darle a esta app el schema `produccion` entero. El SQL para crearla está en
// docs/kalyz-permiso-telas.sql.
const CONSULTA_VISTA = `
  SELECT linea_id::text AS linea_id, fecha::text AS fecha, corte,
         tela, cantidad::float AS cantidad, unidad,
         precio_centavos, importe_centavos, registrado_en
    FROM core.v_tela_de_shato
   WHERE ($1::date IS NULL OR fecha > $1::date)
   ORDER BY fecha, registrado_en`;

// El de respaldo, por si en KALYZ se resolvió dando permiso sobre las tablas en
// vez de la vista. Copiado de core.cuenta_entre_sociedades (0267 + 0271):
// mismas tablas, mismos filtros, misma cascada de precios.
const CONSULTA_TABLAS = `
  SELECT ct.id::text                                    AS linea_id,
         c.fecha::text                                   AS fecha,
         c.numero                                        AS corte,
         tt.nombre || coalesce(' · ' || te.color, '')     AS tela,
         ct.cantidad::float                               AS cantidad,
         tt.unidad                                        AS unidad,
         coalesce(ct.precio_transferencia_centavos,
                  te.precio_transferencia_override_centavos,
                  tt.precio_transferencia_centavos)       AS precio_centavos,
         coalesce(ct.importe_transferencia_centavos,
                  round(ct.cantidad * coalesce(te.precio_transferencia_override_centavos,
                                               tt.precio_transferencia_centavos))::bigint,
                  0::bigint)                              AS importe_centavos,
         ct.creado_en                                     AS registrado_en
    FROM produccion.cortes_telas ct
    JOIN produccion.cortes c       ON c.id = ct.corte_id
    JOIN produccion.telas te       ON te.id = ct.tela_id
    JOIN produccion.tipos_tela tt  ON tt.id = te.tipo_tela_id
    JOIN core.empresas e           ON e.codigo = ct.empresa_codigo
    JOIN core.empresas ep          ON ep.codigo = 'produccion'
   WHERE e.paga_transferencia_tela
     AND e.sociedad_codigo  = $1
     AND ep.sociedad_codigo = $2
     AND NOT ct.anulada AND NOT c.anulado
     AND NOT coalesce(ct.es_prueba, false)
     AND ($3::date IS NULL OR c.fecha > $3::date)
   ORDER BY c.fecha, ct.creado_en`;

const cent = v => (v == null ? null : Number(v) / 100);

async function sincronizarTelas(sql, env = process.env) {
  if (!env.KALYZ_DATABASE_URL) return { ok: false, saltado: true, error: "falta KALYZ_DATABASE_URL" };

  const desde = await limiteCargaManual(sql);

  const { Client } = require("pg");
  const client = new Client({
    connectionString: cadenaConexionKalyz(env.KALYZ_DATABASE_URL),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    query_timeout: 30000,
    application_name: "tussy-app/telas",
  });

  let filas, via;
  try {
    await client.connect();
    try {
      const r = await client.query(CONSULTA_VISTA, [desde]);
      filas = r.rows;
      via = "vista";
    } catch (eVista) {
      if (!/permission denied|does not exist|no existe/i.test(eVista.message)) throw eVista;
      const r = await client.query(CONSULTA_TABLAS, [SOCIEDAD_ACREEDORA, SOCIEDAD_DEUDORA, desde]);
      filas = r.rows;
      via = "tablas";
    }
  } catch (e) {
    // El caso esperado hoy: tussy_app_lectura no ve ni la vista ni produccion.
    const falta = /permission denied|no existe|does not exist/i.test(e.message);
    return { ok: false, sinPermiso: falta, desde, error: e.message };
  } finally {
    await client.end().catch(() => {});
  }

  // Espejo de la ventana: lo que KALYZ ya no devuelve (un corte anulado, o uno
  // que quedó tapado por un cargo a mano posterior) se va de acá también.
  const ids = filas.map(f => f.linea_id);
  const borradas = await sql`
    DELETE FROM telas_consumidas
     WHERE (${desde}::date IS NULL OR fecha > ${desde}::date)
       AND NOT (linea_id = ANY(${ids}::uuid[]))
    RETURNING linea_id`;

  let nuevas = 0;
  for (let i = 0; i < filas.length; i += 500) {
    const c = filas.slice(i, i + 500);
    const r = await sql`
      INSERT INTO telas_consumidas
        (linea_id, fecha, corte, tela, cantidad, unidad, precio, monto, registrado_en)
      SELECT * FROM UNNEST(
        ${c.map(f => f.linea_id)}::uuid[], ${c.map(f => f.fecha)}::date[],
        ${c.map(f => (f.corte == null ? null : Number(f.corte)))}::bigint[],
        ${c.map(f => f.tela)}::text[], ${c.map(f => f.cantidad)}::numeric[],
        ${c.map(f => f.unidad || "kg")}::text[],
        ${c.map(f => cent(f.precio_centavos))}::numeric[],
        ${c.map(f => cent(f.importe_centavos) ?? 0)}::numeric[],
        ${c.map(f => f.registrado_en)}::timestamptz[]
      ) AS x(linea_id, fecha, corte, tela, cantidad, unidad, precio, monto, registrado_en)
      ON CONFLICT (linea_id) DO UPDATE SET
        fecha = EXCLUDED.fecha, corte = EXCLUDED.corte, tela = EXCLUDED.tela,
        cantidad = EXCLUDED.cantidad, unidad = EXCLUDED.unidad,
        precio = EXCLUDED.precio, monto = EXCLUDED.monto,
        registrado_en = EXCLUDED.registrado_en, sincronizado_en = now()
      RETURNING (xmax = 0) AS insertado`;
    nuevas += r.filter(x => x.insertado).length;
  }

  return { ok: true, via, desde, leidas: filas.length, nuevas, borradas: borradas.length };
}

module.exports = { sincronizarTelas, limiteCargaManual, SOCIEDAD_ACREEDORA, SOCIEDAD_DEUDORA };
