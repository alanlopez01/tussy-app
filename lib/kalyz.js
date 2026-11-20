// Lectura de los comprobantes RECIBIDOS desde KALYZ.
//
// ARCA no tiene web service para los recibidos: «Mis Comprobantes» es una
// pantalla con clave fiscal. Por eso en KALYZ los trae un robot que entra con
// la clave, los lee y los carga, todos los días a las 7. Ese robot ya incluye a
// Tussy S.A. desde el 20-oct-2026.
//
// Acá NO se arma un segundo robot: se leen los que el de KALYZ ya bajó. Un solo
// lugar que entra a ARCA, un solo juego de credenciales fiscales, y cuando ARCA
// cambie la pantalla se arregla una vez. Es el mismo criterio con el que se lee
// el stock del Tussy ERP (lib/erp.js).
//
// Los EMITIDOS no pasan por acá: esos sí tienen web service y los trae
// `arcaSync` desde siempre (lib/arca.js).
//
// Necesita KALYZ_DATABASE_URL: un usuario de SOLO LECTURA sobre
// core.comprobantes_recibidos. Si no está, la sincronización se saltea sin
// romper el cierre.

// OJO: es "tussy_sa", la sociedad. "tussy" existe en KALYZ pero es la marca, y
// con ese código la consulta devuelve CERO FILAS SIN ERROR, que es la peor forma
// de fallar: el cierre diría "0 comprobantes" todas las noches sin avisar nada.
const SOCIEDAD = "tussy_sa";   // core.sociedades.codigo de Tussy S.A.

// Misma precaución que con el ERP: si la contraseña trae caracteres que rompen
// el parseo de la URL (un '#', por ejemplo), se escapa sin tocar el resto.
function cadenaConexionKalyz(cadena) {
  try { new URL(cadena); return cadena; } catch { /* sigue abajo */ }
  const m = cadena.match(/^(postgresql?:\/\/)([^:@/]+):(.*)@([^@]+)$/);
  if (!m) return cadena;
  const [, esquema, usuario, pass, resto] = m;
  return `${esquema}${usuario}:${encodeURIComponent(pass)}@${resto}`;
}

const cent = v => (v == null ? 0 : Number(v) / 100);

// Trae de KALYZ los recibidos de Tussy desde `desde` y los deja en la tabla
// local. Idempotente: la clave es (cuit_emisor, tipo, punto_venta, numero), así
// que repetir no duplica, y si ARCA corrigió un importe se actualiza.
async function sincronizarRecibidos(sql, desde, env = process.env) {
  if (!env.KALYZ_DATABASE_URL) return { ok: false, saltado: true, error: "falta KALYZ_DATABASE_URL" };

  const { Client } = require("pg");
  const client = new Client({
    connectionString: cadenaConexionKalyz(env.KALYZ_DATABASE_URL),
    ssl: { rejectUnauthorized: false },   // el pooler de Supabase presenta su propio certificado
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    query_timeout: 30000,
    application_name: "tussy-app/comprobantes",
  });

  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT fecha_emision, tipo, punto_venta, numero, cuit_emisor, emisor,
              neto_gravado_centavos, iva_centavos, otros_tributos_centavos, total_centavos
         FROM core.comprobantes_recibidos
        WHERE sociedad_codigo = $1 AND fecha_emision >= $2
        ORDER BY fecha_emision`,
      [SOCIEDAD, desde]
    );
    if (!rows.length) return { ok: true, leidos: 0, nuevos: 0, desde };

    // La fecha viene como Date del driver; a texto YYYY-MM-DD, que es lo que
    // guarda la tabla local.
    const dia = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    let nuevos = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const c = rows.slice(i, i + 500);
      const r = await sql`
        INSERT INTO comprobantes_recibidos
          (fecha, tipo, punto_venta, numero, cuit_emisor, emisor, neto, iva, otros_tributos, total)
        SELECT * FROM UNNEST(
          ${c.map(f => dia(f.fecha_emision))}::date[], ${c.map(f => f.tipo)}::int[],
          ${c.map(f => f.punto_venta)}::int[], ${c.map(f => String(f.numero))}::bigint[],
          ${c.map(f => String(f.cuit_emisor))}::bigint[], ${c.map(f => f.emisor || null)}::text[],
          ${c.map(f => cent(f.neto_gravado_centavos))}::numeric[], ${c.map(f => cent(f.iva_centavos))}::numeric[],
          ${c.map(f => cent(f.otros_tributos_centavos))}::numeric[], ${c.map(f => cent(f.total_centavos))}::numeric[]
        ) AS x(fecha, tipo, punto_venta, numero, cuit_emisor, emisor, neto, iva, otros_tributos, total)
        ON CONFLICT (cuit_emisor, tipo, punto_venta, numero) DO UPDATE SET
          fecha = EXCLUDED.fecha, emisor = COALESCE(EXCLUDED.emisor, comprobantes_recibidos.emisor),
          neto = EXCLUDED.neto, iva = EXCLUDED.iva,
          otros_tributos = EXCLUDED.otros_tributos, total = EXCLUDED.total
        RETURNING (xmax = 0) AS insertado`;
      nuevos += r.filter(x => x.insertado).length;
    }
    return { ok: true, leidos: rows.length, nuevos, desde };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { sincronizarRecibidos, cadenaConexionKalyz, SOCIEDAD };
