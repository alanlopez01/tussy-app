// Movimientos bancarios: parseo del extracto de Galicia y categorización común
// (también se usa para clasificar los egresos de MercadoPago).
//
// El circuito real de la plata es: cobranzas entran a MercadoPago → se transfieren
// a la cuenta de Galicia (aparecen como "TUSSY S.A.", cuenta propia) → desde Galicia
// se pagan sueldos, AFIP, echeqs y proveedores. Sin el extracto de Galicia, esas
// transferencias a cuenta propia parecen pagos sin factura.

const CUIT_TUSSY = "30718039947";

// Un movimiento es "cuenta propia" cuando la contraparte es la propia empresa:
// no es un gasto, es plata que cambia de bolsillo.
function esCuentaPropia(nombre, cuit) {
  if (cuit && String(cuit).replace(/\D/g, "") === CUIT_TUSSY) return true;
  const n = String(nombre || "").toUpperCase();
  return /\bTUSSY\b/.test(n);
}

const CATEGORIA_PROPIA = "Transferencias cuenta propia";

// Reglas en orden: la primera que matchea gana. Contemplan el vocabulario de los
// dos orígenes: Galicia ("Trf Inmed Proveed", "Echeq…") y MercadoPago
// ("Transferencia enviada X", "Pago Facebook", "Pago de impuestos X").
const REGLAS = [
  [/acreditamiento de haberes|acred\.?haberes|sueldos/i, "Sueldos"],
  [/\bafip\b|\barca\b|\bvep\b|imp\.afip|plan ?rg|\babl\b/i, "Impuestos"],
  [/echeq|cheque/i, "Cheques a proveedores"],
  [/faceb|meta ads/i, "Publicidad"],
  [/env[íi]o|correo|dhl|andreani|oca\b|pedidosya/i, "Envíos"],
  [/aubasa|autopistas|peaje/i, "Logística"],
  [/payway|posnet|terminal|descuento de cupones/i, "Comisiones de tarjeta"],
  [/pago visa empresa|tarjeta/i, "Tarjeta corporativa"],
  [/seguro|galicia seguros|\bsmg\b|mercantil andina|federacion patro/i, "Seguros"],
  [/zoo logic|software|adobe|spotify|openai|capcut|perfit|kive|wnpower|leadsales|rawpixel|vectormagic|tiendanube|merpago\*|clv\*|mgf\*|google|alibaba|aysa|edesur|edenor|metrogas|\badt\b|personal|flow|telecom|claro|movistar/i, "Servicios y software"],
  [/compra mercado ?libre|compra mercado/i, "Compras Mercado Libre"],
  // Las transferencias a terceros son pagos a proveedores en los dos sistemas
  [/trf inmed proveed|transferencias cash proveedores|transferencia de terceros|transferencia enviada|transferencia programada|pago con transferencia/i, "Proveedores"],
  [/pago de impuestos|imp\. ?deb\.|imp\. ?cre\.|ing\. ?brutos|percep|impuesto de sellos|sircreb|^iva$/i, "Impuestos y sellos bancarios"],
  [/comision|intereses|servicio de cuenta|com\. ?certif/i, "Gastos bancarios"],
  [/deb\. ?autom/i, "Débitos automáticos"],
];

function categorizar(descripcion, contraparte, cuit) {
  if (esCuentaPropia(contraparte, cuit)) return CATEGORIA_PROPIA;
  const texto = `${descripcion || ""} ${contraparte || ""}`;
  for (const [re, cat] of REGLAS) if (re.test(texto)) return cat;
  return "Otros";
}

// ── Extracto de Galicia (CSV con ; y comillas, números "1.234,56") ──

function aNumeroAR(s) {
  const t = String(s ?? "").trim();
  if (!t) return 0;
  return parseFloat(t.replace(/\./g, "").replace(",", ".")) || 0;
}

function partirCSV(linea) {
  // El archivo viene con todos los campos entre comillas y separados por ;
  return linea.split(";").map(c => c.replace(/^"|"$/g, "").trim());
}

// Devuelve filas { id, fecha, descripcion, contraparte, cuit, monto, categoria }
// con monto NEGATIVO para débitos y POSITIVO para créditos.
function parsearGalicia(texto) {
  const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  if (!lineas.length) throw new Error("El archivo está vacío.");
  const headers = partirCSV(lineas[0]).map(h => h.toLowerCase());
  const col = frag => headers.findIndex(h => h.includes(frag));
  const idx = {
    fecha: col("fecha"), desc: col("descrip"), deb: col("débito") >= 0 ? col("débito") : col("debito"),
    cred: col("crédito") >= 0 ? col("crédito") : col("credito"),
    comp: col("número de comprobante") >= 0 ? col("número de comprobante") : col("comprobante"),
    ley1: headers.findIndex(h => h.includes("leyendas adicionales1")),
    ley2: headers.findIndex(h => h.includes("leyendas adicionales2")),
    saldo: col("saldo"),
  };
  if (idx.fecha < 0 || idx.desc < 0 || (idx.deb < 0 && idx.cred < 0)) {
    throw new Error("No reconozco el formato: falta Fecha, Descripción o Débitos/Créditos. ¿Es el extracto de Galicia?");
  }

  const vistos = {};
  const filas = [];
  for (const linea of lineas.slice(1)) {
    const c = partirCSV(linea);
    const f = (c[idx.fecha] || "").match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!f) continue;
    const fecha = `${f[3]}-${f[2]}-${f[1]}`;
    const debito = idx.deb >= 0 ? aNumeroAR(c[idx.deb]) : 0;
    const credito = idx.cred >= 0 ? aNumeroAR(c[idx.cred]) : 0;
    const monto = credito > 0 ? credito : -debito;
    if (!monto) continue;

    const descripcion = c[idx.desc] || "";
    const ley1 = idx.ley1 >= 0 ? c[idx.ley1] : "";
    const ley2 = idx.ley2 >= 0 ? c[idx.ley2] : "";
    // La leyenda 2 suele traer el CUIT de la contraparte; la 1, el nombre.
    const cuit = /^\d{11}$/.test(ley2) ? ley2 : null;
    const contraparte = ley1 || null;

    // No hay ID de transacción: la clave es fecha + saldo resultante + monto,
    // que es único dentro de una cuenta (el saldo es acumulado).
    const base = `galicia|${fecha}|${idx.saldo >= 0 ? c[idx.saldo] : ""}|${monto}`;
    vistos[base] = (vistos[base] || 0) + 1;

    filas.push({
      id: vistos[base] > 1 ? `${base}#${vistos[base]}` : base,
      origen: "galicia",
      fecha,
      descripcion,
      contraparte,
      cuit: cuit ? Number(cuit) : null,
      monto,
      comprobante: idx.comp >= 0 ? (c[idx.comp] || null) : null,
      categoria: categorizar(descripcion, contraparte, cuit),
    });
  }
  if (!filas.length) throw new Error("No encontré movimientos en el archivo.");
  return filas;
}

module.exports = { parsearGalicia, categorizar, esCuentaPropia, CATEGORIA_PROPIA, CUIT_TUSSY };
