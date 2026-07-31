// Cliente de los web services de ARCA (ex AFIP) para consultar comprobantes emitidos.
// WSAA: autenticación con certificado (el ticket dura 12 h y se cachea en la base,
// porque ARCA rechaza pedir uno nuevo mientras el anterior siga vigente).
// WSFE: consulta de comprobantes electrónicos (solo lectura: nunca emitimos).
//
// Requiere en el entorno:
//   ARCA_CERT — certificado X.509 en PEM (lo emite ARCA con el CSR de secrets/)
//   ARCA_KEY  — clave privada en PEM (secrets/arca.key)
const forge = require("node-forge");

const CUIT = 30718039947;
const WSAA_URL = "https://wsaa.afip.gov.ar/ws/services/LoginCms";
const WSFE_URL = "https://servicios1.afip.gov.ar/wsfev1/service.asmx";

// Tipos de comprobante que barremos (facturas y notas de crédito/débito A, B y C)
const TIPOS_CBTE = [1, 2, 3, 6, 7, 8, 11, 12, 13];
const NOMBRES_TIPO = {
  1: "Factura A", 2: "ND A", 3: "NC A",
  6: "Factura B", 7: "ND B", 8: "NC B",
  11: "Factura C", 12: "ND C", 13: "NC C",
};

function arcaConfigurada() {
  return !!(process.env.ARCA_CERT && process.env.ARCA_KEY);
}

// ── WSAA: obtener ticket de acceso (token + firma) ──

function firmarTRA(traXml) {
  const cert = forge.pki.certificateFromPem(process.env.ARCA_CERT);
  const key = forge.pki.privateKeyFromPem(process.env.ARCA_KEY);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

function extraer(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

async function obtenerTicket(sql) {
  const [cache] = await sql`SELECT token, firma FROM arca_ta
    WHERE servicio = 'wsfe' AND expira > now() + interval '5 minutes'`;
  if (cache) return { token: cache.token, firma: cache.firma };

  const ahora = Date.now();
  const tra = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(ahora / 1000)}</uniqueId>
    <generationTime>${new Date(ahora - 10 * 60000).toISOString()}</generationTime>
    <expirationTime>${new Date(ahora + 10 * 60000).toISOString()}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>`;

  const cms = firmarTRA(tra);
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body>
</soapenv:Envelope>`;

  const r = await fetch(WSAA_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: soap,
  });
  const cuerpo = await r.text();
  if (!r.ok) {
    const falla = extraer(cuerpo, "faultstring") || cuerpo.slice(0, 300);
    throw new Error(`WSAA ${r.status}: ${falla}`);
  }
  // La respuesta trae el loginTicketResponse escapado dentro de loginCmsReturn
  const escapado = extraer(cuerpo, "loginCmsReturn") || "";
  const ticketXml = escapado.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const token = extraer(ticketXml, "token");
  const firma = extraer(ticketXml, "sign");
  const expira = extraer(ticketXml, "expirationTime");
  if (!token || !firma) throw new Error("WSAA no devolvió token: " + ticketXml.slice(0, 300));

  await sql`INSERT INTO arca_ta (servicio, token, firma, expira)
    VALUES ('wsfe', ${token}, ${firma}, ${expira})
    ON CONFLICT (servicio) DO UPDATE SET token = ${token}, firma = ${firma}, expira = ${expira}`;
  return { token, firma };
}

// ── WSFE: llamadas SOAP ──

async function llamarWSFE(metodo, auth, cuerpoXml) {
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soap:Body>
    <ar:${metodo}>
      <ar:Auth><ar:Token>${auth.token}</ar:Token><ar:Sign>${auth.firma}</ar:Sign><ar:Cuit>${CUIT}</ar:Cuit></ar:Auth>
      ${cuerpoXml}
    </ar:${metodo}>
  </soap:Body>
</soap:Envelope>`;
  const r = await fetch(WSFE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `http://ar.gov.afip.dif.FEV1/${metodo}`,
    },
    body: soap,
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`WSFE ${metodo} ${r.status}: ${texto.slice(0, 300)}`);
  const err = extraer(texto, "Err");
  if (err && !extraer(texto, "ResultGet")) {
    throw new Error(`WSFE ${metodo}: ${extraer(err, "Msg") || err.slice(0, 200)}`);
  }
  return texto;
}

async function puntosDeVenta(auth) {
  const xml = await llamarWSFE("FEParamGetPtosVenta", auth, "");
  const puntos = [];
  const re = /<PtoVenta>([\s\S]*?)<\/PtoVenta>/g;
  let m;
  while ((m = re.exec(xml))) {
    const bloqueado = extraer(m[1], "Bloqueado");
    const nro = parseInt(extraer(m[1], "Nro") || "0");
    if (nro && bloqueado !== "S") puntos.push(nro);
  }
  return puntos;
}

async function ultimoAutorizado(auth, ptoVta, tipo) {
  const xml = await llamarWSFE("FECompUltimoAutorizado", auth,
    `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${tipo}</ar:CbteTipo>`);
  return parseInt(extraer(xml, "CbteNro") || "0");
}

async function consultarComprobante(auth, ptoVta, tipo, numero) {
  const xml = await llamarWSFE("FECompConsultar", auth,
    `<ar:FeCompConsReq><ar:CbteTipo>${tipo}</ar:CbteTipo><ar:CbteNro>${numero}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`);
  const res = extraer(xml, "ResultGet");
  if (!res) return null;
  const f = extraer(res, "CbteFch") || ""; // yyyymmdd
  return {
    fecha: `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`,
    tipo,
    punto_venta: ptoVta,
    numero,
    doc_tipo: parseInt(extraer(res, "DocTipo") || "0") || null,
    doc_nro: parseInt(extraer(res, "DocNro") || "0") || null,
    neto: parseFloat(extraer(res, "ImpNeto") || "0"),
    iva: parseFloat(extraer(res, "ImpIVA") || "0"),
    otros_tributos: parseFloat(extraer(res, "ImpTrib") || "0"),
    total: parseFloat(extraer(res, "ImpTotal") || "0"),
    cae: extraer(res, "CodAutorizacion") || null,
  };
}

// ── Barrido incremental: trae lo nuevo desde el último cursor ──
// maxComprobantes limita el trabajo por corrida (resumible: el cursor queda en la base).
async function sincronizarEmitidos(sql, { maxComprobantes = 400 } = {}) {
  if (!arcaConfigurada()) return { ok: false, motivo: "sin certificado ARCA configurado" };
  const auth = await obtenerTicket(sql);
  const puntos = await puntosDeVenta(auth);
  let cargados = 0, pendientes = 0;

  for (const pv of puntos) {
    for (const tipo of TIPOS_CBTE) {
      const ultimo = await ultimoAutorizado(auth, pv, tipo);
      if (!ultimo) continue;
      const [cur] = await sql`SELECT ultimo FROM arca_cursor WHERE punto_venta = ${pv} AND tipo = ${tipo}`;
      let desde = (cur ? Number(cur.ultimo) : 0) + 1;
      if (desde > ultimo) continue;

      while (desde <= ultimo && cargados < maxComprobantes) {
        const lote = [];
        const hasta = Math.min(desde + 7, ultimo, desde + (maxComprobantes - cargados) - 1);
        for (let n = desde; n <= hasta; n++) lote.push(consultarComprobante(auth, pv, tipo, n));
        const comps = (await Promise.all(lote)).filter(Boolean);
        for (const c of comps) {
          await sql`INSERT INTO comprobantes_emitidos
            (fecha, tipo, punto_venta, numero, doc_tipo, doc_nro, neto, iva, otros_tributos, total, cae, fuente)
            VALUES (${c.fecha}, ${c.tipo}, ${c.punto_venta}, ${c.numero}, ${c.doc_tipo}, ${c.doc_nro},
                    ${c.neto}, ${c.iva}, ${c.otros_tributos}, ${c.total}, ${c.cae}, 'wsfe')
            ON CONFLICT (tipo, punto_venta, numero) DO UPDATE
              SET fecha = ${c.fecha}, neto = ${c.neto}, iva = ${c.iva},
                  otros_tributos = ${c.otros_tributos}, total = ${c.total}, cae = ${c.cae}, fuente = 'wsfe'`;
        }
        cargados += hasta - desde + 1;
        desde = hasta + 1;
        await sql`INSERT INTO arca_cursor (punto_venta, tipo, ultimo) VALUES (${pv}, ${tipo}, ${desde - 1})
          ON CONFLICT (punto_venta, tipo) DO UPDATE SET ultimo = ${desde - 1}`;
      }
      if (desde <= ultimo) pendientes += ultimo - desde + 1;
    }
  }
  return { ok: true, cargados, pendientes, puntos };
}

module.exports = {
  arcaConfigurada, sincronizarEmitidos, NOMBRES_TIPO, CUIT,
  obtenerTicket, puntosDeVenta, ultimoAutorizado, consultarComprobante,
};
