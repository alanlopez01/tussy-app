/**
 * Google Apps Script — Operaciones (Cierres de Caja, Novedades, Retiros)
 *
 * Este script maneja la hoja de Google Sheets vinculada a APPS_SCRIPT_URL_OPERACIONES.
 *
 * HOJAS NECESARIAS en el Google Sheet:
 * 1. "Cierres"   → Columnas: Fecha | Local | Encargado | VentaEfectivo | VentaElectronico | GastosMonto | Observaciones
 * 2. "Novedades"  → Columnas: Fecha | Local | CreadoPor | Tipo | Descripcion | Estado | CompletadoPor
 * 3. "Retiros"    → Columnas: FechaDesde | FechaHasta | Local | Monto | RetiradoPor | RegistradoPor | FechaRegistro | Verificado | MontoFaltante | VerificadoPor
 *
 * DEPLOY: Publicar como Web App → "Cualquiera puede acceder" → URL en APPS_SCRIPT_URL_OPERACIONES de Vercel
 */

function doGet(e) {
  var action = e.parameter.action;
  var params = e.parameter.params ? JSON.parse(e.parameter.params) : {};

  var result;
  try {
    switch(action) {
      // ── CIERRES DE CAJA ──
      case "getCierres":
        result = getCierres(params);
        break;
      case "guardarCierre":
        result = guardarCierre(params);
        break;
      case "getResumenCaja":
        result = getResumenCaja(params);
        break;

      // ── NOVEDADES ──
      case "getNovedades":
        result = getNovedades(params);
        break;
      case "guardarNovedad":
        result = guardarNovedad(params);
        break;
      case "actualizarEstado":
        result = actualizarEstado(params);
        break;
      case "agregarNotaTarea":
        result = agregarNotaTarea(params);
        break;
      case "agregarFotoTarea":
        result = agregarFotoTarea(params);
        break;

      // ── RETIROS ──
      case "registrarRetiro":
        result = registrarRetiro(params);
        break;
      case "getRetiros":
        result = getRetiros(params);
        break;
      case "getRetirosPendientes":
        result = getRetirosPendientes(params);
        break;
      case "verificarRetiro":
        result = verificarRetiro(params);
        break;

      // ── VENTAS DIARIAS ──
      case "guardarVentaDiaria":
        result = guardarVentaDiaria(params);
        break;
      case "getVentasMes":
        result = getVentasMes(params);
        break;

      // ── PUSH SUBSCRIPTIONS ──
      case "getPushSubs":
        result = getPushSubs();
        break;
      case "guardarPushSub":
        result = guardarPushSub(params);
        break;
      case "eliminarPushSub":
        result = eliminarPushSub(params);
        break;

      case "actualizarDFDiario":
        result = actualizarDFDiario(params);
        break;
      case "limpiarDuplicados":
        result = limpiarDuplicados();
        break;

      // ── STOCK SNAPSHOT ──
      case "getStockSnapshot":
        result = getStockSnapshot();
        break;
      case "getStockHistorico":
        result = getStockHistorico(params);
        break;
      case "actualizarStockSnapshot":
        result = actualizarStockSnapshot();
        break;

      // ── VENTAS DETALLE ──
      case "guardarVentasDetalle":
        result = guardarVentasDetalle(params);
        break;
      case "getVentasDetalle":
        result = getVentasDetalle(params);
        break;
      case "buscarStockUnificado":
        result = buscarStockUnificado(params);
        break;
      case "getStockValorizado":
        result = getStockValorizado(params);
        break;

      default:
        result = { error: "Accion no encontrada: " + action };
    }
  } catch(err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  // Permite enviar payloads grandes (fotos base64) v\u00eda FormData o JSON body
  var params = {};
  var action = "";
  try {
    // Priorizar e.parameter (FormData): funciona con CORS y sin preflight
    if (e && e.parameter && e.parameter.action) {
      action = e.parameter.action;
      params = e.parameter.params ? JSON.parse(e.parameter.params) : {};
    } else if (e && e.postData && e.postData.contents) {
      var body = JSON.parse(e.postData.contents);
      action = body.action || "";
      params = body.params || {};
    }
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Payload invalido: " + err.message })).setMimeType(ContentService.MimeType.JSON);
  }

  var result;
  try {
    switch(action) {
      case "agregarFotoTarea": result = agregarFotoTarea(params); break;
      case "agregarNotaTarea": result = agregarNotaTarea(params); break;
      case "actualizarEstado": result = actualizarEstado(params); break;
      case "guardarNovedad":   result = guardarNovedad(params); break;
      case "getNovedades":     result = getNovedades(params); break;
      default: result = { error: "Accion POST no encontrada: " + action };
    }
  } catch(err2) {
    result = { error: err2.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════════════════════════════════
// CIERRES DE CAJA
// ══════════════════════════════════════════════════════════════════════════════

function getCierres(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Cierres");
  if (!sheet) return { cierres: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { cierres: [] };

  var headers = data[0];
  var cierres = [];

  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    var cierre = {
      idx: i + 1,
      fecha: formatDate(row[0]),
      local: row[1],
      encargado: row[2],
      ventaEfectivo: parseFloat(row[3]) || 0,
      ventaElectronico: parseFloat(row[4]) || 0,
      gastosMonto: parseFloat(row[5]) || 0,
      observaciones: row[6] || "",
      saldoFinal: (parseFloat(row[3]) || 0) - (parseFloat(row[5]) || 0)
    };

    // Filtro por local
    if (params.local && params.local !== "todos" && cierre.local !== params.local) continue;

    cierres.push(cierre);

    // Limite
    if (params.limite && cierres.length >= params.limite) break;
  }

  return { cierres: cierres };
}

function guardarCierre(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Cierres");
  if (!sheet) {
    sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet("Cierres");
    sheet.appendRow(["Fecha", "Local", "Encargado", "VentaEfectivo", "VentaElectronico", "GastosMonto", "Observaciones"]);
  }

  var fecha = params.fecha || new Date().toISOString().split("T")[0];

  sheet.appendRow([
    fecha,
    params.local || "",
    params.encargado || "",
    parseFloat(params.ventaEfectivo) || 0,
    parseFloat(params.ventaElectronico) || 0,
    parseFloat(params.gastosMonto) || 0,
    params.observaciones || ""
  ]);

  // Calcular saldo final
  var saldoFinal = (parseFloat(params.ventaEfectivo) || 0) - (parseFloat(params.gastosMonto) || 0);

  return { ok: true, saldoFinal: saldoFinal };
}

function getResumenCaja(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Cierres");
  var retSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Retiros");

  var locales = ["Dot", "Abasto", "Córdoba", "Palermo", "La Plata"];
  var resumen = {};

  locales.forEach(function(local) {
    resumen[local] = { saldoFinal: 0, ultimaCierre: null };
  });

  // Sumar efectivo de cierres
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var local = data[i][1];
      if (resumen[local] !== undefined) {
        var efectivo = parseFloat(data[i][3]) || 0;
        var gastos = parseFloat(data[i][5]) || 0;
        resumen[local].saldoFinal += (efectivo - gastos);
        resumen[local].ultimaCierre = formatDate(data[i][0]);
      }
    }
  }

  // Restar retiros
  if (retSheet) {
    var retData = retSheet.getDataRange().getValues();
    for (var j = 1; j < retData.length; j++) {
      var retLocal = retData[j][2];
      var retMonto = parseFloat(retData[j][3]) || 0;
      if (resumen[retLocal] !== undefined) {
        resumen[retLocal].saldoFinal -= retMonto;
      }
    }
  }

  return { resumen: resumen };
}

// ══════════════════════════════════════════════════════════════════════════════
// NOVEDADES
// ══════════════════════════════════════════════════════════════════════════════

function getNovedades(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Novedades");
  if (!sheet) return { novedades: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { novedades: [] };

  var novedades = [];

  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    var notas = [];
    var fotos = [];
    try { if (row[8]) notas = JSON.parse(row[8]); } catch(e) {}
    try { if (row[9]) fotos = JSON.parse(row[9]); } catch(e) {}

    var novedad = {
      idx: i + 1,
      fecha: formatDate(row[0]),
      local: row[1],
      creadoPor: row[2],
      tipo: row[3],
      descripcion: row[4],
      estado: row[5] || "Pendiente",
      completadoPor: row[6] || "",
      responsable: row[7] || "",
      notas: notas,
      fotos: fotos,
      fechaFin: row[10] ? formatDate(row[10]) : ""
    };

    // Filtro por local
    if (params.local && params.local !== "todos" && params.local !== null && novedad.local !== params.local) continue;

    novedades.push(novedad);
  }

  return { novedades: novedades };
}

function guardarNovedad(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Novedades");
  if (!sheet) {
    sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet("Novedades");
    sheet.appendRow(["Fecha", "Local", "CreadoPor", "Tipo", "Descripcion", "Estado", "CompletadoPor", "Responsable", "Notas", "Fotos", "FechaFin"]);
  }

  // Asegurar columnas si la hoja es vieja
  if (sheet.getLastColumn() < 11) {
    var head = sheet.getRange(1, 1, 1, 11).getValues()[0];
    if (!head[7]) sheet.getRange(1, 8).setValue("Responsable");
    if (!head[8]) sheet.getRange(1, 9).setValue("Notas");
    if (!head[9]) sheet.getRange(1, 10).setValue("Fotos");
    if (!head[10]) sheet.getRange(1, 11).setValue("FechaFin");
  }

  var fecha = new Date().toISOString().split("T")[0];

  sheet.appendRow([
    fecha,
    params.local || "",
    params.creadoPor || "",
    params.tipo || "Novedad",
    params.descripcion || "",
    "Pendiente",
    "",
    params.responsable || "",
    "[]",
    "[]",
    ""
  ]);

  return { ok: true };
}

function actualizarEstado(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Novedades");
  if (!sheet) return { error: "Hoja no encontrada" };

  var idx = parseInt(params.idx);
  if (!idx || idx < 2) return { error: "Index invalido" };

  var estado = params.estado || "Completado";
  sheet.getRange(idx, 6).setValue(estado);
  sheet.getRange(idx, 7).setValue(params.completadoPor || "");

  // Columna K (11) = FechaFin: se setea cuando pasa a Hecho, se limpia si vuelve
  if (estado === "Hecho" || estado === "Completado") {
    sheet.getRange(idx, 11).setValue(new Date().toISOString().split("T")[0]);
  } else {
    sheet.getRange(idx, 11).setValue("");
  }

  return { ok: true };
}

function agregarNotaTarea(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Novedades");
  if (!sheet) return { error: "Hoja no encontrada" };

  var idx = parseInt(params.idx);
  if (!idx || idx < 2) return { error: "Index invalido" };

  var current = sheet.getRange(idx, 9).getValue();
  var notas = [];
  try { if (current) notas = JSON.parse(current); } catch(e) {}

  notas.push({
    autor: params.autor || "",
    fecha: new Date().toISOString(),
    texto: params.texto || ""
  });

  sheet.getRange(idx, 9).setValue(JSON.stringify(notas));
  return { ok: true, notas: notas };
}

function agregarFotoTarea(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Novedades");
  if (!sheet) return { error: "Hoja no encontrada" };

  var idx = parseInt(params.idx);
  if (!idx || idx < 2) return { error: "Index invalido" };

  // Guardar foto en Drive (dentro de carpeta "TussyTareas")
  var carpeta;
  var folders = DriveApp.getFoldersByName("TussyTareas");
  if (folders.hasNext()) carpeta = folders.next();
  else carpeta = DriveApp.createFolder("TussyTareas");

  var imageData = params.imageData || "";
  // imageData formato: "data:image/jpeg;base64,XXX"
  var match = imageData.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) return { error: "Formato de imagen invalido" };

  var contentType = match[1];
  var bytes = Utilities.base64Decode(match[2]);
  var blob = Utilities.newBlob(bytes, contentType, "tarea_" + idx + "_" + Date.now() + "." + contentType.split("/")[1]);
  var file = carpeta.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // Usamos el URL de miniatura con formato directo para preview inline
  var fileId = file.getId();
  var url = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w1200";

  var current = sheet.getRange(idx, 10).getValue();
  var fotos = [];
  try { if (current) fotos = JSON.parse(current); } catch(e) {}

  fotos.push({
    url: url,
    fileId: fileId,
    autor: params.autor || "",
    fecha: new Date().toISOString()
  });

  sheet.getRange(idx, 10).setValue(JSON.stringify(fotos));
  return { ok: true, fotos: fotos };
}

// ══════════════════════════════════════════════════════════════════════════════
// RETIROS DE EFECTIVO
// ══════════════════════════════════════════════════════════════════════════════

function registrarRetiro(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Retiros");
  if (!sheet) {
    sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet("Retiros");
    sheet.appendRow(["FechaDesde", "FechaHasta", "Local", "Monto", "RetiradoPor", "RegistradoPor", "FechaRegistro", "Verificado", "MontoFaltante", "VerificadoPor"]);
  }

  var fechaRegistro = new Date().toISOString().split("T")[0];

  sheet.appendRow([
    params.fechaDesde || "",
    params.fechaHasta || "",
    params.local || "",
    parseFloat(params.monto) || 0,
    params.retiradoPor || "",
    params.registradoPor || "",
    fechaRegistro,
    "",  // Verificado (vacío = pendiente)
    "",  // MontoFaltante
    ""   // VerificadoPor
  ]);

  return { ok: true };
}

function getRetiros(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Retiros");
  if (!sheet) return { retiros: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { retiros: [] };

  var retiros = [];

  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    var retiro = {
      idx: i + 1,
      fechaDesde: formatDate(row[0]),
      fechaHasta: formatDate(row[1]),
      local: row[2],
      monto: parseFloat(row[3]) || 0,
      retiradoPor: row[4] || "",
      registradoPor: row[5] || "",
      fechaRegistro: formatDate(row[6]),
      verificado: row[7] || "",
      montoFaltante: parseFloat(row[8]) || 0,
      verificadoPor: row[9] || ""
    };

    // Filtro por local si se pasa
    if (params.local && params.local !== "todos" && retiro.local !== params.local) continue;

    retiros.push(retiro);
  }

  return { retiros: retiros };
}

function getRetirosPendientes(params) {
  var data = getRetiros(params || {});
  // Devolver todos (pendientes + verificados) para que el frontend pueda separar
  return data;
}

function verificarRetiro(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Retiros");
  if (!sheet) return { error: "Hoja no encontrada" };

  var idx = parseInt(params.idx);
  if (!idx || idx < 2) return { error: "Index invalido" };

  // Columna H = Verificado (col 8), I = MontoFaltante (col 9), J = VerificadoPor (col 10)
  sheet.getRange(idx, 8).setValue(params.verificado || "correcto");
  sheet.getRange(idx, 9).setValue(parseFloat(params.montoFaltante) || 0);
  sheet.getRange(idx, 10).setValue(params.verificadoPor || "");

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function formatDate(val) {
  if (!val) return "";
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = String(val.getMonth() + 1).padStart(2, "0");
    var d = String(val.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }
  return String(val);
}

// ══════════════════════════════════════════════════════════════════════════════
// PUSH SUBSCRIPTIONS
// ══════════════════════════════════════════════════════════════════════════════
// Hoja "PushSubs" → Columnas: Usuario | Endpoint | Keys | FechaRegistro

function getPushSubs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("PushSubs");
  if (!sheet) return { subs: [] };

  var data = sheet.getDataRange().getValues();
  var subs = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[1]) continue;
    try {
      var keys = JSON.parse(row[2]);
      subs.push({
        usuario: row[0],
        subscription: { endpoint: row[1], keys: keys }
      });
    } catch(e) {}
  }
  return { subs: subs };
}

function guardarPushSub(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("PushSubs");
  if (!sheet) {
    sheet = ss.insertSheet("PushSubs");
    sheet.appendRow(["Usuario", "Endpoint", "Keys", "FechaRegistro"]);
  }

  var endpoint = params.endpoint;
  var keys = params.keys;
  var usuario = params.usuario || "unknown";

  // Remove existing for same endpoint
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === endpoint) {
      sheet.deleteRow(i + 1);
    }
  }

  sheet.appendRow([usuario, endpoint, JSON.stringify(keys), new Date()]);
  return { ok: true };
}

function eliminarPushSub(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("PushSubs");
  if (!sheet) return { ok: true };

  var endpoint = params.endpoint;
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === endpoint) {
      sheet.deleteRow(i + 1);
    }
  }
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// VENTAS DIARIAS — Totales por local por día
// Hoja: "VentasDiarias" → Fecha | Palermo | LaPlata | Online | Dot | Abasto | Cordoba | OpsPalermo | OpsLaPlata | OpsOnline | OpsDot | OpsAbasto | OpsCordoba
// ══════════════════════════════════════════════════════════════════════════════

function guardarVentaDiaria(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("VentasDiarias");
  if (!sheet) {
    sheet = ss.insertSheet("VentasDiarias");
    sheet.appendRow(["Fecha", "Palermo", "LaPlata", "Online", "Dot", "Abasto", "Cordoba", "OpsPalermo", "OpsLaPlata", "OpsOnline", "OpsDot", "OpsAbasto", "OpsCordoba"]);
  }

  var fecha = params.fecha; // "2026-03-01"

  // Helper: usar valor nuevo si está definido (no null/undefined), sino preservar existente
  function mergeVal(nuevo, existente) {
    if (nuevo === null || nuevo === undefined) {
      return existente === null || existente === undefined ? 0 : existente;
    }
    return nuevo;
  }

  // Buscar fila existente para esta fecha y leer sus valores
  var data = sheet.getDataRange().getValues();
  var existente = null;
  var filaExistente = -1;
  for (var i = data.length - 1; i >= 1; i--) {
    var f = data[i][0];
    var fStr;
    if (typeof f === 'object' && f.getFullYear) {
      var yy = f.getFullYear();
      var mm = String(f.getMonth() + 1).padStart(2, "0");
      var dd = String(f.getDate()).padStart(2, "0");
      fStr = yy + "-" + mm + "-" + dd;
    } else {
      fStr = String(f);
    }
    if (fStr === fecha) {
      existente = data[i];
      filaExistente = i + 1;
      break;
    }
  }

  // Si existe, eliminar la fila vieja
  if (filaExistente > 0) {
    sheet.deleteRow(filaExistente);
  }

  var prev = existente || [];
  var newRow = sheet.getLastRow() + 1;
  sheet.getRange(newRow, 1).setNumberFormat('@').setValue(fecha);
  sheet.getRange(newRow, 2).setValue(mergeVal(params.palermo,    prev[1]));
  sheet.getRange(newRow, 3).setValue(mergeVal(params.laplata,    prev[2]));
  sheet.getRange(newRow, 4).setValue(mergeVal(params.online,     prev[3]));
  sheet.getRange(newRow, 5).setValue(mergeVal(params.dot,        prev[4]));
  sheet.getRange(newRow, 6).setValue(mergeVal(params.abasto,     prev[5]));
  sheet.getRange(newRow, 7).setValue(mergeVal(params.cordoba,    prev[6]));
  sheet.getRange(newRow, 8).setValue(mergeVal(params.opsPalermo, prev[7]));
  sheet.getRange(newRow, 9).setValue(mergeVal(params.opsLaPlata, prev[8]));
  sheet.getRange(newRow, 10).setValue(mergeVal(params.opsOnline, prev[9]));
  sheet.getRange(newRow, 11).setValue(mergeVal(params.opsDot,    prev[10]));
  sheet.getRange(newRow, 12).setValue(mergeVal(params.opsAbasto, prev[11]));
  sheet.getRange(newRow, 13).setValue(mergeVal(params.opsCordoba, prev[12]));
  return { ok: true, merged: filaExistente > 0 };
}

function getVentasMes(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("VentasDiarias");
  if (!sheet) return { dias: [], totales: {} };

  var mes = params.mes; // "2026-03"
  var data = sheet.getDataRange().getValues();
  var dias = [];
  var totales = { palermo: 0, laplata: 0, online: 0, dot: 0, abasto: 0, cordoba: 0, opsPalermo: 0, opsLaPlata: 0, opsOnline: 0, opsDot: 0, opsAbasto: 0, opsCordoba: 0 };

  for (var i = 1; i < data.length; i++) {
    var f = data[i][0];
    var fStr;
    if (typeof f === 'object' && f.getFullYear) {
      var yy = f.getFullYear();
      var mm = String(f.getMonth() + 1).padStart(2, "0");
      var dd = String(f.getDate()).padStart(2, "0");
      fStr = yy + "-" + mm + "-" + dd;
    } else {
      fStr = String(f);
    }
    if (fStr.substring(0, 7) === mes) {
      var dia = {
        fecha: fStr,
        palermo: Number(data[i][1]) || 0,
        laplata: Number(data[i][2]) || 0,
        online: Number(data[i][3]) || 0,
        dot: Number(data[i][4]) || 0,
        abasto: Number(data[i][5]) || 0,
        cordoba: Number(data[i][6]) || 0,
        opsPalermo: Number(data[i][7]) || 0,
        opsLaPlata: Number(data[i][8]) || 0,
        opsOnline: Number(data[i][9]) || 0,
        opsDot: Number(data[i][10]) || 0,
        opsAbasto: Number(data[i][11]) || 0,
        opsCordoba: Number(data[i][12]) || 0
      };
      dias.push(dia);
      totales.palermo += dia.palermo;
      totales.laplata += dia.laplata;
      totales.online += dia.online;
      totales.dot += dia.dot;
      totales.abasto += dia.abasto;
      totales.cordoba += dia.cordoba;
      totales.opsPalermo += dia.opsPalermo;
      totales.opsLaPlata += dia.opsLaPlata;
      totales.opsOnline += dia.opsOnline;
      totales.opsDot += dia.opsDot;
      totales.opsAbasto += dia.opsAbasto;
      totales.opsCordoba += dia.opsCordoba;
    }
  }

  return { dias: dias, totales: totales };
}

// Eliminar filas duplicadas en VentasDiarias (dejar solo la primera de cada fecha)
function limpiarDuplicados() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("VentasDiarias");
  if (!sheet) return { error: "No sheet" };

  var data = sheet.getDataRange().getValues();
  var seen = {};
  var rowsToDelete = [];

  for (var i = 1; i < data.length; i++) {
    var f = data[i][0];
    var fStr;
    if (typeof f === 'object' && f.getFullYear) {
      var yy = f.getFullYear();
      var mm = String(f.getMonth() + 1).padStart(2, "0");
      var dd = String(f.getDate()).padStart(2, "0");
      fStr = yy + "-" + mm + "-" + dd;
    } else {
      fStr = String(f);
    }
    if (seen[fStr]) {
      rowsToDelete.push(i + 1); // 1-indexed
    } else {
      seen[fStr] = true;
    }
  }

  // Delete from bottom to top to preserve row indices
  for (var j = rowsToDelete.length - 1; j >= 0; j--) {
    sheet.deleteRow(rowsToDelete[j]);
  }

  return { ok: true, deleted: rowsToDelete.length };
}

// Actualizar solo columnas de Dragonfish para una fecha existente
function actualizarDFDiario(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("VentasDiarias");
  if (!sheet) return { error: "No sheet" };

  var fecha = params.fecha;
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var f = data[i][0];
    var fStr;
    if (typeof f === 'object' && f.getFullYear) {
      var yy = f.getFullYear();
      var mm = String(f.getMonth() + 1).padStart(2, "0");
      var dd = String(f.getDate()).padStart(2, "0");
      fStr = yy + "-" + mm + "-" + dd;
    } else {
      fStr = String(f);
    }
    if (fStr === fecha) {
      var row = i + 1;
      sheet.getRange(row, 5).setValue(params.dot || 0);       // Col E = Dot
      sheet.getRange(row, 6).setValue(params.abasto || 0);    // Col F = Abasto
      sheet.getRange(row, 7).setValue(params.cordoba || 0);   // Col G = Cordoba
      sheet.getRange(row, 11).setValue(params.opsDot || 0);    // Col K = OpsDot
      sheet.getRange(row, 12).setValue(params.opsAbasto || 0); // Col L = OpsAbasto
      sheet.getRange(row, 13).setValue(params.opsCordoba || 0);// Col M = OpsCordoba
      return { ok: true, row: row };
    }
  }

  return { error: "Fecha no encontrada: " + fecha };
}

// ══════════════════════════════════════════════════════════════
//  STOCK SNAPSHOT
//
//  PRE-REQUISITOS:
//   En Apps Script > Project Settings > Script Properties agregar:
//     WOO_PALERMO_URL, WOO_PALERMO_KEY, WOO_PALERMO_SECRET
//     WOO_LAPLATA_URL, WOO_LAPLATA_KEY, WOO_LAPLATA_SECRET
//     VERCEL_BASE (ej. https://tussy-app.vercel.app)
//
//  HOJAS:
//   StockActual:    Producto | Palermo | LaPlata | Dot | Abasto | Cordoba | Total
//   StockHistorico: Fecha | Palermo | LaPlata | Dot | Abasto | Cordoba | Total | Productos
//
//  TRIGGER SUGERIDO: Diario 02:00am → actualizarStockSnapshot
// ══════════════════════════════════════════════════════════════

function _wooFetch_(url, key, secret, path) {
  var auth = Utilities.base64Encode(key + ":" + secret);
  var full = url + "/wp-json/wc/v3/" + path;
  var sep = path.indexOf("?") >= 0 ? "&" : "?";
  full += sep + "_fields=id,name,type,stock_quantity,stock_status";
  try {
    var resp = UrlFetchApp.fetch(full, {
      headers: { "Authorization": "Basic " + auth },
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code !== 200) return null;
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return null;
  }
}

function _wooVariationsFetch_(url, key, secret, productId, page) {
  var auth = Utilities.base64Encode(key + ":" + secret);
  var full = url + "/wp-json/wc/v3/products/" + productId + "/variations?per_page=100&page=" + page + "&_fields=id,stock_quantity,stock_status";
  try {
    var resp = UrlFetchApp.fetch(full, {
      headers: { "Authorization": "Basic " + auth },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return null;
    return JSON.parse(resp.getContentText());
  } catch (e) {
    return null;
  }
}

function _fetchWooStock_(url, key, secret) {
  // Trae todos los productos paginando (incluye price y regular_price)
  var productos = [];
  for (var page = 1; page <= 20; page++) {
    var listUrl = url + "/wp-json/wc/v3/products?per_page=100&page=" + page + "&status=publish&_fields=id,name,type,stock_quantity,stock_status,price,regular_price";
    var auth = Utilities.base64Encode(key + ":" + secret);
    try {
      var resp = UrlFetchApp.fetch(listUrl, {
        headers: { "Authorization": "Basic " + auth },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200) break;
      var d = JSON.parse(resp.getContentText());
      if (!d || !d.length) break;
      productos.push.apply(productos, d);
      if (d.length < 100) break;
    } catch (e) { break; }
  }

  // Trae variantes de cada producto variable usando fetchAll (paralelo)
  var stockPorProducto = {};

  // Inicializar stock de productos simples + precio
  productos.forEach(function(p) {
    var keyName = (p.name || "").toUpperCase().trim();
    if (!stockPorProducto[keyName]) stockPorProducto[keyName] = { nombre: p.name, stock: 0, precio: 0 };
    // Precio base del producto (para simples, y para variables como fallback)
    var precioProducto = parseFloat(p.price || p.regular_price || 0);
    if (precioProducto > 0 && stockPorProducto[keyName].precio === 0) {
      stockPorProducto[keyName].precio = precioProducto;
    }
    if (p.type !== "variable" && p.stock_quantity != null && p.stock_quantity > 0) {
      stockPorProducto[keyName].stock += p.stock_quantity;
    }
  });

  // Productos variables → batch de UrlFetchApp.fetchAll
  var variables = productos.filter(function(p) { return p.type === "variable"; });
  var auth = Utilities.base64Encode(key + ":" + secret);
  var BATCH = 15;

  for (var i = 0; i < variables.length; i += BATCH) {
    var slice = variables.slice(i, i + BATCH);
    var requests = slice.map(function(p) {
      return {
        url: url + "/wp-json/wc/v3/products/" + p.id + "/variations?per_page=100&page=1&_fields=id,stock_quantity,stock_status,price,regular_price",
        headers: { "Authorization": "Basic " + auth },
        muteHttpExceptions: true
      };
    });
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      continue;
    }
    for (var j = 0; j < responses.length; j++) {
      var r = responses[j];
      if (r.getResponseCode() !== 200) continue;
      var vars_;
      try { vars_ = JSON.parse(r.getContentText()); } catch (e) { continue; }
      if (!Array.isArray(vars_)) continue;
      var p = slice[j];
      var keyName = (p.name || "").toUpperCase().trim();
      if (!stockPorProducto[keyName]) stockPorProducto[keyName] = { nombre: p.name, stock: 0, precio: 0 };
      vars_.forEach(function(v) {
        if (v.stock_quantity != null && v.stock_quantity > 0) {
          stockPorProducto[keyName].stock += v.stock_quantity;
        }
        // Tomar precio de la primera variante que tenga
        if (stockPorProducto[keyName].precio === 0) {
          var precioVar = parseFloat(v.price || v.regular_price || 0);
          if (precioVar > 0) stockPorProducto[keyName].precio = precioVar;
        }
      });
    }
  }

  return stockPorProducto;
}

function _fetchDragonfishStock_() {
  var base = PropertiesService.getScriptProperties().getProperty("VERCEL_BASE") || "https://tussy-app.vercel.app";
  try {
    var resp = UrlFetchApp.fetch(base + "/api/dragonfish?action=reporteStock", {
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return null;
    return JSON.parse(resp.getContentText());
  } catch (e) { return null; }
}

function actualizarStockSnapshot() {
  var props = PropertiesService.getScriptProperties();
  var WP_URL = props.getProperty("WOO_PALERMO_URL");
  var WP_KEY = props.getProperty("WOO_PALERMO_KEY");
  var WP_SEC = props.getProperty("WOO_PALERMO_SECRET");
  var LP_URL = props.getProperty("WOO_LAPLATA_URL");
  var LP_KEY = props.getProperty("WOO_LAPLATA_KEY");
  var LP_SEC = props.getProperty("WOO_LAPLATA_SECRET");

  if (!WP_URL || !LP_URL) {
    return { error: "Faltan Script Properties con credenciales WooCommerce" };
  }

  var palermo = _fetchWooStock_(WP_URL, WP_KEY, WP_SEC);
  var laplata = _fetchWooStock_(LP_URL, LP_KEY, LP_SEC);
  var df = _fetchDragonfishStock_();

  var mapa = {};
  // Palermo
  Object.keys(palermo).forEach(function(k) {
    if (!mapa[k]) mapa[k] = { nombre: palermo[k].nombre, palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0, precio: 0 };
    mapa[k].palermo = palermo[k].stock;
    if (palermo[k].precio > 0) mapa[k].precio = palermo[k].precio;
  });
  // La Plata (usar precio de LP si Palermo no lo trajo)
  Object.keys(laplata).forEach(function(k) {
    if (!mapa[k]) mapa[k] = { nombre: laplata[k].nombre, palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0, precio: 0 };
    mapa[k].laplata = laplata[k].stock;
    if (mapa[k].precio === 0 && laplata[k].precio > 0) mapa[k].precio = laplata[k].precio;
  });
  // Dragonfish
  if (df && df.productos) {
    df.productos.forEach(function(p) {
      var k = (p.nombre || "").toUpperCase().trim();
      if (!mapa[k]) mapa[k] = { nombre: p.nombre, palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0, precio: 0 };
      mapa[k].dot = p.dot || 0;
      mapa[k].abasto = p.abasto || 0;
      mapa[k].cordoba = p.cordoba || 0;
      if (mapa[k].precio === 0 && p.precio > 0) mapa[k].precio = p.precio;
    });
  }

  var productos = Object.keys(mapa).map(function(k) {
    var p = mapa[k];
    var totalUnidades = p.palermo + p.laplata + p.dot + p.abasto + p.cordoba;
    var valorizado = Math.round(totalUnidades * (p.precio || 0));
    return [p.nombre, p.palermo, p.laplata, p.dot, p.abasto, p.cordoba, totalUnidades, p.precio || 0, valorizado];
  });
  productos.sort(function(a, b) { return b[6] - a[6]; });

  // Escribir StockActual (9 columnas)
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("StockActual");
  if (!sh) {
    sh = ss.insertSheet("StockActual");
    sh.appendRow(["Producto", "Palermo", "LaPlata", "Dot", "Abasto", "Cordoba", "Total", "Precio", "Valorizado"]);
    sh.getRange(1, 1, 1, 9).setFontWeight("bold").setBackground("#1A1A2E").setFontColor("#FFFFFF");
  } else {
    // Verificar si necesita ampliar a 9 columnas (header viejo tenía 7)
    var lastCol = sh.getLastColumn();
    if (lastCol < 9) {
      sh.getRange(1, 8).setValue("Precio").setFontWeight("bold").setBackground("#1A1A2E").setFontColor("#FFFFFF");
      sh.getRange(1, 9).setValue("Valorizado").setFontWeight("bold").setBackground("#1A1A2E").setFontColor("#FFFFFF");
    }
  }
  // Limpiar contenido anterior (9 columnas)
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 9).clearContent();
  if (productos.length > 0) {
    sh.getRange(2, 1, productos.length, 9).setValues(productos);
  }

  // Calcular totales
  var totales = productos.reduce(function(acc, p) {
    acc.palermo += p[1]; acc.laplata += p[2]; acc.dot += p[3]; acc.abasto += p[4]; acc.cordoba += p[5];
    return acc;
  }, { palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0 });
  var total = totales.palermo + totales.laplata + totales.dot + totales.abasto + totales.cordoba;

  // Escribir StockHistorico (append)
  var sh2 = ss.getSheetByName("StockHistorico");
  if (!sh2) {
    sh2 = ss.insertSheet("StockHistorico");
    sh2.appendRow(["Fecha", "Palermo", "LaPlata", "Dot", "Abasto", "Cordoba", "Total", "Productos"]);
    sh2.getRange(1, 1, 1, 8).setFontWeight("bold").setBackground("#1A1A2E").setFontColor("#FFFFFF");
  }
  var fechaHoy = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
  // Reemplazar si ya hay fila de hoy
  var hdata = sh2.getDataRange().getValues();
  var foundRow = -1;
  for (var i = 1; i < hdata.length; i++) {
    var f = hdata[i][0];
    var fStr = (typeof f === "object" && f && f.getFullYear) ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd") : String(f).substring(0, 10);
    if (fStr === fechaHoy) { foundRow = i + 1; break; }
  }
  var row = [fechaHoy, totales.palermo, totales.laplata, totales.dot, totales.abasto, totales.cordoba, total, productos.length];
  if (foundRow > 0) {
    sh2.getRange(foundRow, 1, 1, 8).setValues([row]);
  } else {
    sh2.appendRow(row);
  }

  // Guardar última fecha
  props.setProperty("STOCK_SNAPSHOT_TS", new Date().toISOString());

  return {
    ok: true,
    fecha: fechaHoy,
    productos: productos.length,
    totales: totales,
    total: total
  };
}

function getStockSnapshot() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("StockActual");
  if (!sh) return { productos: [], totales: { palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0 }, total: 0 };

  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { productos: [], totales: { palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0 }, total: 0 };

  var productos = [];
  var totales = { palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0 };
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue;
    productos.push({ nombre: r[0], palermo: r[1] || 0, laplata: r[2] || 0, dot: r[3] || 0, abasto: r[4] || 0, cordoba: r[5] || 0, total: r[6] || 0 });
    totales.palermo += r[1] || 0;
    totales.laplata += r[2] || 0;
    totales.dot += r[3] || 0;
    totales.abasto += r[4] || 0;
    totales.cordoba += r[5] || 0;
  }
  var total = totales.palermo + totales.laplata + totales.dot + totales.abasto + totales.cordoba;

  var props = PropertiesService.getScriptProperties();
  var ts = props.getProperty("STOCK_SNAPSHOT_TS") || "";

  return {
    productos: productos,
    totales: totales,
    total: total,
    cantidadProductos: productos.length,
    actualizadoEn: ts
  };
}

function getStockHistorico(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("StockHistorico");
  if (!sh) return { historico: [] };
  var dias = (params && params.dias) ? parseInt(params.dias) : 30;
  var data = sh.getDataRange().getValues();
  var historico = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue;
    var f = r[0];
    var fStr = (typeof f === "object" && f && f.getFullYear) ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd") : String(f).substring(0, 10);
    historico.push({ fecha: fStr, palermo: r[1] || 0, laplata: r[2] || 0, dot: r[3] || 0, abasto: r[4] || 0, cordoba: r[5] || 0, total: r[6] || 0, productos: r[7] || 0 });
  }
  historico.sort(function(a, b) { return a.fecha < b.fecha ? 1 : -1; });
  return { historico: historico.slice(0, dias) };
}

// ══════════════════════════════════════════════════════
// VENTAS DETALLE — Guardado diario de líneas de venta
// Hoja "VentasDetalle": Fecha | Local | Sistema | Producto | SKU | Color | Talle | Cantidad | PrecioUnit | Total
// ══════════════════════════════════════════════════════

function guardarVentasDetalle(params) {
  var fecha = params.fecha || _hoyArgStr_();
  // soloLocales: si viene un array, solo se re-fetchean esos locales (y solo se
  // borran/reescriben sus filas). Usado por reintentarSyncErrores para no
  // regenerar todo el día cuando solo un local falló → ahorra 4+ minutos.
  var soloLocales = Array.isArray(params.soloLocales) ? params.soloLocales : null;
  var incluir = function(nombre) { return !soloLocales || soloLocales.indexOf(nombre) >= 0; };
  var filas = [];
  var localesOk = {};
  var erroresFetch = [];

  // WooCommerce Palermo
  if (incluir("Palermo")) try {
    var wooP = _fetchWooDetalle_(
      PropertiesService.getScriptProperties().getProperty("WOO_PALERMO_URL"),
      PropertiesService.getScriptProperties().getProperty("WOO_PALERMO_KEY"),
      PropertiesService.getScriptProperties().getProperty("WOO_PALERMO_SECRET"),
      fecha, "Palermo"
    );
    filas = filas.concat(wooP);
    localesOk["Palermo"] = true;
  } catch(e) {
    Logger.log("Error WOO Palermo: " + e.message);
    erroresFetch.push({ local: "Palermo", sistema: "WooCommerce", error: e.message });
  }

  // WooCommerce La Plata
  if (incluir("La Plata")) try {
    var wooLP = _fetchWooDetalle_(
      PropertiesService.getScriptProperties().getProperty("WOO_LAPLATA_URL"),
      PropertiesService.getScriptProperties().getProperty("WOO_LAPLATA_KEY"),
      PropertiesService.getScriptProperties().getProperty("WOO_LAPLATA_SECRET"),
      fecha, "La Plata"
    );
    filas = filas.concat(wooLP);
    localesOk["La Plata"] = true;
  } catch(e) {
    Logger.log("Error WOO La Plata: " + e.message);
    erroresFetch.push({ local: "La Plata", sistema: "WooCommerce", error: e.message });
  }

  // Tiendanube Tussy
  if (incluir("Tiendanube")) try {
    var tn = _fetchTNDetalle_(fecha);
    filas = filas.concat(tn);
    localesOk["Tiendanube"] = true;
  } catch(e) {
    Logger.log("Error TN: " + e.message);
    erroresFetch.push({ local: "Tiendanube", sistema: "Tiendanube", error: e.message });
  }

  // Dragonfish: Dot, Abasto, Córdoba
  var dfLocales = [
    { key: "dot",     nombre: "Dot",     urlProp: "DF_DOT_URL",     tokenProp: "DF_JWTOKEN_DOT",     bdProp: "DF_BASE_DATOS_DOT",     bdDefault: "DOT" },
    { key: "abasto",  nombre: "Abasto",  urlProp: "DF_ABASTO_URL",  tokenProp: "DF_JWTOKEN_ABASTO",  bdProp: "DF_BASE_DATOS_ABASTO",  bdDefault: "ABASTO" },
    { key: "cordoba", nombre: "Córdoba", urlProp: "DF_CORDOBA_URL", tokenProp: "DF_JWTOKEN_CORDOBA", bdProp: "DF_BASE_DATOS_CORDOBA", bdDefault: "CORDOBA" }
  ];
  var props = PropertiesService.getScriptProperties().getProperties();
  dfLocales.filter(function(loc) { return incluir(loc.nombre); }).forEach(function(loc) {
    var url   = props[loc.urlProp];
    var token = props[loc.tokenProp];
    var bd    = props[loc.bdProp] || loc.bdDefault;
    if (!url || !token) {
      Logger.log("DF " + loc.nombre + " sin credenciales");
      erroresFetch.push({ local: loc.nombre, sistema: "Dragonfish", error: "sin credenciales (URL/JWT)" });
      return;
    }
    try {
      var df = _fetchDFDetalle_(url, token, bd, fecha, loc.nombre);
      if (df && df.ok) {
        filas = filas.concat(df.filas);
        localesOk[loc.nombre] = true;
      } else {
        var err = (df && df.error) || "sin detalle";
        Logger.log("⚠️ DF " + loc.nombre + " fetch NO confiable: " + err + " → se preservan filas previas de " + fecha);
        erroresFetch.push({ local: loc.nombre, sistema: "Dragonfish", error: err });
      }
    } catch(e) {
      Logger.log("Error DF " + loc.nombre + ": " + e.message);
      erroresFetch.push({ local: loc.nombre, sistema: "Dragonfish", error: e.message });
    }
  });

  // Registrar errores en hoja SyncErrors (audit trail persistente)
  if (erroresFetch.length > 0) _registrarSyncErrors_(fecha, erroresFetch);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("VentasDetalle");
  if (!hoja) {
    hoja = ss.insertSheet("VentasDetalle");
    hoja.appendRow(["Fecha","Local","Sistema","Producto","SKU","Color","Talle","Cantidad","PrecioUnit","Total"]);
    hoja.setFrozenRows(1);
  }

  // Eliminar filas existentes SOLO de los locales cuyo fetch fue confiable.
  // Los locales que fallaron conservan sus filas previas → no se pierden datos.
  var datos = hoja.getDataRange().getValues();
  var filasAEliminar = [];
  for (var i = datos.length - 1; i >= 1; i--) {
    var f = datos[i][0];
    var fStr = (typeof f === "object" && f && f.getFullYear) ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd") : String(f).substring(0, 10);
    var localFila = String(datos[i][1] || "");
    if (fStr === fecha && localesOk[localFila]) filasAEliminar.push(i + 1);
  }
  filasAEliminar.forEach(function(r) { hoja.deleteRow(r); });

  // Escribir nuevas filas
  var rows = filas.map(function(f) {
    return [f.fecha, f.local, f.sistema, f.producto, f.sku || "", f.color || "", f.talle || "", f.cantidad, f.precioUnit, f.total];
  });
  if (rows.length > 0) {
    hoja.getRange(hoja.getLastRow() + 1, 1, rows.length, 10).setValues(rows);
  }

  return {
    ok: erroresFetch.length === 0,
    filas: rows.length,
    fecha: fecha,
    localesOk: Object.keys(localesOk),
    errores: erroresFetch
  };
}

// ── Log persistente de errores de sync (hoja SyncErrors) ──
function _registrarSyncErrors_(fecha, errores) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("SyncErrors");
  if (!hoja) {
    hoja = ss.insertSheet("SyncErrors");
    hoja.appendRow(["TimestampEjecucion", "FechaDato", "Local", "Sistema", "Error", "Resuelto"]);
    hoja.setFrozenRows(1);
  }
  _asegurarColumnaResuelto_(hoja);
  var ts = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd HH:mm:ss");
  var rows = errores.map(function(e) { return [ts, fecha, e.local, e.sistema, e.error, ""]; });
  hoja.getRange(hoja.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
}

// Asegura que exista la columna F "Resuelto" en SyncErrors (para hojas creadas antes de Layer 3).
function _asegurarColumnaResuelto_(hoja) {
  if (hoja.getLastColumn() < 6) {
    hoja.getRange(1, 6).setValue("Resuelto");
  } else {
    var h = hoja.getRange(1, 6).getValue();
    if (h !== "Resuelto") hoja.getRange(1, 6).setValue("Resuelto");
  }
}

// Devuelve { "YYYY-MM-DD": { "Córdoba": true, ... } } con TODOS los locales que tienen
// al menos un error no resuelto en esa fecha.
function _cargarErroresNoResueltosPorFecha_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("SyncErrors");
  if (!hoja) return {};
  _asegurarColumnaResuelto_(hoja);
  var datos = hoja.getDataRange().getValues();
  var mapa = {};
  for (var i = 1; i < datos.length; i++) {
    if (datos[i][5]) continue; // ya resuelto
    var fecha = datos[i][1];
    var fechaStr = (typeof fecha === "object" && fecha && fecha.getFullYear)
      ? Utilities.formatDate(fecha, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(fecha).substring(0, 10);
    var local = String(datos[i][2] || "");
    if (!mapa[fechaStr]) mapa[fechaStr] = {};
    mapa[fechaStr][local] = true;
  }
  return mapa;
}

// ── Layer 3: reintento automático de fetches fallidos ──
// Corre cada hora vía trigger. Solo hace trabajo entre 10:00 y 22:00 Arg.
// Para cada (fecha, local) con error no resuelto:
//   1) Reintenta guardarVentasDetalle(fecha).
//   2) Si el local que había fallado ahora está OK → propaga a VentasDiarias
//      y marca las filas de SyncErrors como resueltas.
function reintentarSyncErrores() {
  var hora = parseInt(Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "H"), 10);
  if (hora < 10 || hora > 22) return { skipped: true, motivo: "fuera de horario", hora: hora };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("SyncErrors");
  if (!hoja) return { skipped: true, motivo: "SyncErrors no existe" };
  _asegurarColumnaResuelto_(hoja);

  var datos = hoja.getDataRange().getValues();
  if (datos.length < 2) return { ok: true, motivo: "sin errores registrados" };

  // Agrupar filas pendientes por fecha → local → [numFila,...]
  var pendientes = {};
  for (var i = 1; i < datos.length; i++) {
    if (datos[i][5]) continue;
    var fecha = datos[i][1];
    var fechaStr = (typeof fecha === "object" && fecha && fecha.getFullYear)
      ? Utilities.formatDate(fecha, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(fecha).substring(0, 10);
    var local = String(datos[i][2] || "");
    if (!pendientes[fechaStr]) pendientes[fechaStr] = {};
    if (!pendientes[fechaStr][local]) pendientes[fechaStr][local] = [];
    pendientes[fechaStr][local].push(i + 1);
  }

  var fechas = Object.keys(pendientes).sort();
  if (fechas.length === 0) return { ok: true, motivo: "no hay errores no resueltos", hora: hora };

  var tsResuelto = Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd HH:mm:ss");
  var reporte = [];
  // Corte por tiempo: los triggers de Apps Script mueren a los 6 min. Dejamos margen.
  var tInicio = new Date().getTime();
  var LIMITE_MS = 5 * 60 * 1000;
  var procesadas = 0;
  var salteadas = 0;

  for (var idx = 0; idx < fechas.length; idx++) {
    if (new Date().getTime() - tInicio > LIMITE_MS) {
      salteadas = fechas.length - idx;
      Logger.log("⏱ Corte por tiempo. Quedan " + salteadas + " fechas para el próximo run.");
      break;
    }
    var fecha = fechas[idx];
    var localesAReintentar = Object.keys(pendientes[fecha]);
    var r;
    try {
      // Solo re-fetchea los locales que fallaron, no los 6 sistemas completos.
      r = guardarVentasDetalle({ fecha: fecha, soloLocales: localesAReintentar });
    } catch(e) {
      reporte.push({ fecha: fecha, ok: false, error: e.message });
      continue;
    }
    var localesOk = r.localesOk || [];
    var resueltos = [];
    localesAReintentar.forEach(function(local) {
      if (localesOk.indexOf(local) >= 0) {
        resueltos.push(local);
        pendientes[fecha][local].forEach(function(numFila) {
          hoja.getRange(numFila, 6).setValue(tsResuelto);
        });
      }
    });
    if (resueltos.length > 0) {
      try { sincronizarVentasDiariasDesdeDetalle(fecha, fecha); } catch(e) {}
      Logger.log("✅ Reintento OK " + fecha + " → " + resueltos.join(", "));
    } else {
      Logger.log("⏳ Reintento pendiente " + fecha + " (" + localesAReintentar.join(", ") + ")");
    }
    reporte.push({ fecha: fecha, resueltos: resueltos, sigueFallando: (r.errores || []).map(function(e){return e.local;}) });
    procesadas++;
  }

  return { ok: true, procesadas: procesadas, salteadas: salteadas, hora: hora, reporte: reporte };
}

// Crear el trigger de reintento cada 1 hora. Ejecutar UNA vez para instalarlo.
function crearTriggerReintentoSyncErrores() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "reintentarSyncErrores") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("reintentarSyncErrores").timeBased().everyHours(1).create();
  Logger.log("✅ Trigger creado: reintentarSyncErrores cada 1h (filtra 10-22 Arg internamente)");
}

function _hoyArgStr_() {
  return Utilities.formatDate(new Date(), "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
}

function _ayerArgStr_() {
  var ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  return Utilities.formatDate(ayer, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
}

function _fetchWooDetalle_(baseUrl, key, secret, fecha, localNombre) {
  var auth = Utilities.base64Encode(key + ":" + secret);
  var headers = { "Authorization": "Basic " + auth };
  var filas = [];
  var page = 1;

  // Calcular día siguiente para el rango "before"
  var dParts = fecha.split("-");
  var dObj = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2])+1));
  var diaSig = Utilities.formatDate(dObj, "UTC", "yyyy-MM-dd");

  while (true) {
    var url = baseUrl + "/wp-json/wc/v3/orders?status=completed,processing&after=" + fecha + "T03:00:00Z&before=" + diaSig + "T02:59:59Z&per_page=100&page=" + page;
    var resp = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) break;
    var orders = JSON.parse(resp.getContentText());
    if (!Array.isArray(orders) || orders.length === 0) break;

    orders.forEach(function(order) {
      (order.line_items || []).forEach(function(item) {
        var color = "";
        var talle = "";
        // Extraer color y talle de meta_data
        (item.meta_data || []).forEach(function(m) {
          var k = (m.key || "").toLowerCase();
          var v = String(m.value || "");
          if (k === "color" || k === "colour" || k === "pa_color") color = v;
          else if (k === "talle" || k === "size" || k === "pa_talle" || k === "pa_size" || k === "talla") talle = v;
          else if (k === "atributo_1" || k === "attribute_pa_color") color = color || v;
          else if (k === "atributo_2" || k === "attribute_pa_talle") talle = talle || v;
        });
        // También buscar en el nombre del producto (ej: "Remera Negra - Talle L")
        if (!color && !talle && item.name) {
          var partes = item.name.split(" - ");
          if (partes.length >= 2) talle = partes[partes.length - 1].trim();
        }
        var precioUnit = item.quantity > 0 ? parseFloat(item.total || 0) / item.quantity : 0;
        filas.push({
          fecha: fecha,
          local: localNombre,
          sistema: "WooCommerce",
          producto: item.name || "",
          sku: item.sku || "",
          color: color,
          talle: talle,
          cantidad: parseInt(item.quantity || 1),
          precioUnit: Math.round(precioUnit),
          total: parseFloat(item.total || 0)
        });
      });
    });

    if (orders.length < 100) break;
    page++;
  }

  return filas;
}

function _fetchTNDetalle_(fecha) {
  var props = PropertiesService.getScriptProperties().getProperties();
  var token = props["TN_ACCESS_TOKEN"];
  var userId = props["TN_USER_ID"];
  if (!token || !userId) return [];

  var filas = [];
  var page = 1;

  // Calcular día siguiente para el rango "before" (igual que ventas.js)
  var dParts = fecha.split("-");
  var dSig = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2])+1));
  var diaSig = Utilities.formatDate(dSig, "UTC", "yyyy-MM-dd");

  var inicioUTC = fecha   + "T03:00:00+0000";
  var finUTC    = diaSig  + "T02:59:59+0000";

  while (true) {
    // SIN filtro payment_status — incluimos todas las órdenes válidas (matchea con el panel TN)
    var url = "https://api.tiendanube.com/v1/" + userId + "/orders?created_at_min=" + inicioUTC + "&created_at_max=" + finUTC + "&per_page=200&page=" + page;
    var resp = UrlFetchApp.fetch(url, {
      headers: { "Authentication": "bearer " + token, "User-Agent": "TussyApp/1.0" },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) break;
    var orders = JSON.parse(resp.getContentText());
    if (!Array.isArray(orders) || orders.length === 0) break;

    orders.forEach(function(order) {
      // Solo contar órdenes que TN considera ventas reales
      var orderStatus = String(order.status || "").toLowerCase();
      var paymentStatus = String(order.payment_status || "").toLowerCase();
      if (orderStatus === "cancelled") return;
      var statusValidos = ["paid", "partially_paid"];
      if (statusValidos.indexOf(paymentStatus) === -1) return;

      // Calcular subtotal de productos
      var subtotalProductos = 0;
      (order.products || []).forEach(function(item) {
        subtotalProductos += parseFloat(item.price || 0) * parseInt(item.quantity || 1);
      });
      var shipping = parseFloat(order.shipping_cost_customer || order.shipping_cost_owner || 0);
      var descuento = parseFloat(order.discount || 0) + parseFloat(order.discount_coupon || 0) + parseFloat(order.discount_gateway || 0);
      var totalOrden = parseFloat(order.total || 0);

      (order.products || []).forEach(function(item) {
        var color = "";
        var talle = "";
        // Variantes de Tiendanube
        if (item.variant && item.variant.values) {
          item.variant.values.forEach(function(v, idx) {
            var nombre = (item.variant.attribute_names || [])[idx] || "";
            var valor = String(v || "");
            if (nombre.toLowerCase().indexOf("color") >= 0 || nombre.toLowerCase().indexOf("colour") >= 0) color = valor;
            else if (nombre.toLowerCase().indexOf("talle") >= 0 || nombre.toLowerCase().indexOf("size") >= 0 || nombre.toLowerCase().indexOf("talla") >= 0) talle = valor;
            else if (idx === 0 && !color) color = valor;
            else if (idx === 1 && !talle) talle = valor;
          });
        }
        // Fallback: parsear color y talle del nombre si vienen como "Producto (Color, Talle)"
        var nombreBase = item.name || "";
        if ((!color || !talle) && nombreBase.indexOf("(") >= 0) {
          var matchParen = nombreBase.match(/\(([^)]+)\)$/);
          if (matchParen) {
            var partes = matchParen[1].split(",").map(function(s) { return s.trim(); });
            if (!color && partes[0]) color = partes[0];
            if (!talle && partes[1]) talle = partes[1];
            // Limpiar el nombre base quitando los paréntesis
            nombreBase = nombreBase.replace(/\s*\([^)]+\)$/, "").trim();
          }
        }

        var qty = parseInt(item.quantity || 1);
        var precioUnit = parseFloat(item.price || 0);
        filas.push({
          fecha: fecha,
          local: "Tiendanube",
          sistema: "Tiendanube",
          producto: nombreBase,
          sku: item.sku || "",
          color: color,
          talle: talle,
          cantidad: qty,
          precioUnit: Math.round(precioUnit),
          total: Math.round(precioUnit * qty)
        });
      });

      // Líneas adicionales por orden: envío, descuento y ajuste
      if (shipping > 0) {
        filas.push({ fecha: fecha, local: "Tiendanube", sistema: "Tiendanube", producto: "ENVIO", sku: "", color: "", talle: "", cantidad: 1, precioUnit: Math.round(shipping), total: Math.round(shipping) });
      }
      if (descuento > 0) {
        filas.push({ fecha: fecha, local: "Tiendanube", sistema: "Tiendanube", producto: "DESCUENTO", sku: "", color: "", talle: "", cantidad: 1, precioUnit: -Math.round(descuento), total: -Math.round(descuento) });
      }
      var sumaCalculada = subtotalProductos + shipping - descuento;
      var diferencia = totalOrden - sumaCalculada;
      if (Math.abs(diferencia) > 1) {
        filas.push({ fecha: fecha, local: "Tiendanube", sistema: "Tiendanube", producto: "AJUSTE", sku: "", color: "", talle: "", cantidad: 1, precioUnit: Math.round(diferencia), total: Math.round(diferencia) });
      }
    });

    if (orders.length < 200) break;
    page++;
  }

  return filas;
}

function _fetchDFDetalle_(baseUrl, token, baseDatos, fecha, localNombre) {
  var filas = [];
  var page = 1;
  var idCliente = PropertiesService.getScriptProperties().getProperty("DF_ID_CLIENTE") || "API";

  // Calcular timestamps de inicio y fin del día en Argentina (UTC-3)
  var dParts = fecha.split("-");
  var tsInicio = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2]), 3, 0, 0)).getTime();
  var tsFin    = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2])+1, 2, 59, 59)).getTime();

  while (true) {
    var url = baseUrl + "/api.Dragonfish/Facturaagrupada/?limit=50&page=" + page + "&sort=-Fecha";
    var resp;
    try {
      resp = UrlFetchApp.fetch(url, {
        headers: { "Authorization": token, "idCliente": idCliente, "BaseDeDatos": baseDatos, "Content-Type": "application/json" },
        muteHttpExceptions: true
      });
    } catch (e) {
      return { ok: false, filas: [], error: "excepción red página " + page + ": " + e.message };
    }
    var code = resp.getResponseCode();
    if (code !== 200) {
      // HTTP != 200: token vencido, servidor caído, etc. Cortamos y reportamos error.
      return { ok: false, filas: [], error: "HTTP " + code + " en página " + page };
    }
    var data;
    try { data = JSON.parse(resp.getContentText()); }
    catch (e) { return { ok: false, filas: [], error: "JSON inválido página " + page }; }
    var resultados = Array.isArray(data) ? data : (data.Resultados || []);
    if (!resultados || resultados.length === 0) break;

    var hayMasViejas = false;
    resultados.forEach(function(fac) {
      // Parsear fecha Dragonfish "/Date(timestamp-0300)/"
      var fechaMatch = String(fac.Fecha || "").match(/\/Date\((\d+)/);
      if (!fechaMatch) return;
      var ts = parseInt(fechaMatch[1]);
      if (ts < tsInicio) { hayMasViejas = true; return; }
      if (ts > tsFin) return;

      // Extraer líneas del detalle (ya viene embebido en la respuesta)
      var detalle = fac.FacturaDetalle || [];
      detalle.forEach(function(item) {
        filas.push({
          fecha: fecha,
          local: localNombre,
          sistema: "Dragonfish",
          producto: item.ArticuloDetalle || "",
          sku: item.Articulo || "",
          color: item.ColorDetalle || "",
          talle: item.Talle || "",
          cantidad: parseInt(item.Cantidad || 1),
          precioUnit: Math.round(parseFloat(item.Precio || 0)),
          total: Math.round(parseFloat(item.Monto || item.Precio || 0))
        });
      });
    });

    if (resultados.length < 50 || hayMasViejas) break;
    page++;
  }

  return { ok: true, filas: filas, error: null };
}

// Función para ejecutar manualmente o via trigger: guarda el día anterior
function guardarVentasDetalleAyer() {
  // Re-procesa los últimos 5 días para captar transferencias confirmadas tarde.
  // El insert ya borra filas existentes de cada fecha antes de escribir, así que es seguro.
  var DIAS_HACIA_ATRAS = 5;
  var resultados = [];
  for (var i = 1; i <= DIAS_HACIA_ATRAS; i++) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    var fecha = Utilities.formatDate(d, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
    try {
      var r = guardarVentasDetalle({ fecha: fecha });
      Logger.log("VentasDetalle " + fecha + ": " + JSON.stringify(r));
      resultados.push({ fecha: fecha, ok: true, filas: r.filas });
    } catch (e) {
      Logger.log("Error " + fecha + ": " + e.message);
      resultados.push({ fecha: fecha, ok: false, error: e.message });
    }
  }
  return { resultados: resultados };
}

// Carga un rango de fechas completo (para backfill)
// Uso: cargarRangoFechas("2026-04-01", "2026-04-22")
function cargarRangoFechas(desde, hasta) {
  var inicio = new Date(desde + "T12:00:00Z");
  var fin    = new Date(hasta + "T12:00:00Z");
  var tiempoInicio = new Date().getTime();
  var LIMITE_MS = 5 * 60 * 1000; // 5 minutos máximo

  var actual = new Date(inicio);
  var procesados = [];
  var saltados = [];

  while (actual <= fin) {
    // Verificar tiempo disponible
    if (new Date().getTime() - tiempoInicio > LIMITE_MS) {
      var proximaFecha = Utilities.formatDate(actual, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
      Logger.log("⚠️ Tiempo límite alcanzado. Retomá desde: cargarRangoFechas(\"" + proximaFecha + "\", \"" + hasta + "\")");
      break;
    }

    var fechaStr = Utilities.formatDate(actual, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
    try {
      var r = guardarVentasDetalle({ fecha: fechaStr });
      Logger.log("✅ " + fechaStr + " → " + r.filas + " filas");
      procesados.push(fechaStr);
    } catch(e) {
      Logger.log("❌ " + fechaStr + " → " + e.message);
      saltados.push(fechaStr);
    }

    actual.setDate(actual.getDate() + 1);
  }

  Logger.log("Resumen: " + procesados.length + " días OK, " + saltados.length + " con error");
}

// Shortcut: carga todo el mes actual hasta ayer
function cargarMesActual() {
  var hoy = new Date();
  var anio = hoy.getFullYear();
  var mes = String(hoy.getMonth() + 1).padStart(2, "0");
  var desde = anio + "-" + mes + "-01";
  var hasta = _ayerArgStr_();
  Logger.log("Cargando " + desde + " → " + hasta);
  cargarRangoFechas(desde, hasta);
}

// ══════════════════════════════════════════════════════
// BACKFILL MASIVO: trae todo el rango de una sola vez por sistema
// Mucho más rápido que día por día. Ejecutar una vez para poblar el historial.
// ══════════════════════════════════════════════════════
function backfillRango(desde, hasta) {
  if (!desde) desde = "2026-04-05"; // ajustá según donde quedaste
  if (!hasta) hasta = _ayerArgStr_();
  Logger.log("Backfill masivo: " + desde + " → " + hasta);

  var props = PropertiesService.getScriptProperties().getProperties();
  var filas = [];

  // ── WooCommerce Palermo ──
  try {
    var wP = _fetchWooRango_(props["WOO_PALERMO_URL"], props["WOO_PALERMO_KEY"], props["WOO_PALERMO_SECRET"], desde, hasta, "Palermo");
    filas = filas.concat(wP);
    Logger.log("Palermo WC: " + wP.length + " filas");
  } catch(e) { Logger.log("Error Palermo: " + e.message); }

  // ── WooCommerce La Plata ──
  try {
    var wLP = _fetchWooRango_(props["WOO_LAPLATA_URL"], props["WOO_LAPLATA_KEY"], props["WOO_LAPLATA_SECRET"], desde, hasta, "La Plata");
    filas = filas.concat(wLP);
    Logger.log("La Plata WC: " + wLP.length + " filas");
  } catch(e) { Logger.log("Error La Plata: " + e.message); }

  // ── Tiendanube ──
  try {
    var tn = _fetchTNRango_(desde, hasta);
    filas = filas.concat(tn);
    Logger.log("Tiendanube: " + tn.length + " filas");
  } catch(e) { Logger.log("Error TN: " + e.message); }

  // ── Dragonfish ──
  var dfLocales = [
    { nombre: "Dot",     urlP: "DF_DOT_URL",     tokenP: "DF_JWTOKEN_DOT",     bd: props["DF_BASE_DATOS_DOT"]     || "DOT" },
    { nombre: "Abasto",  urlP: "DF_ABASTO_URL",  tokenP: "DF_JWTOKEN_ABASTO",  bd: props["DF_BASE_DATOS_ABASTO"]  || "ABASTO" },
    { nombre: "Córdoba", urlP: "DF_CORDOBA_URL",  tokenP: "DF_JWTOKEN_CORDOBA", bd: props["DF_BASE_DATOS_CORDOBA"] || "CORDOBA" }
  ];
  dfLocales.forEach(function(loc) {
    var url = props[loc.urlP]; var token = props[loc.tokenP];
    if (!url || !token) return;
    try {
      var df = _fetchDFRango_(url, token, loc.bd, desde, hasta, loc.nombre);
      filas = filas.concat(df);
      Logger.log(loc.nombre + " DF: " + df.length + " filas");
    } catch(e) { Logger.log("Error DF " + loc.nombre + ": " + e.message); }
  });

  if (filas.length === 0) { Logger.log("Sin filas"); return; }

  // Escribir en el Sheet eliminando primero el rango (optimizado con clearContents)
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("VentasDetalle");
  if (!hoja) {
    hoja = ss.insertSheet("VentasDetalle");
    hoja.appendRow(["Fecha","Local","Sistema","Producto","SKU","Color","Talle","Cantidad","PrecioUnit","Total"]);
    hoja.setFrozenRows(1);
  }

  // Filtrar y reescribir todo de una sola vez (rapidísimo)
  var datos = hoja.getDataRange().getValues();
  var header = datos[0];
  var conservar = [header];
  var eliminadas = 0;
  for (var i = 1; i < datos.length; i++) {
    var f = datos[i][0];
    var fStr = (typeof f === "object" && f.getFullYear) ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd") : String(f).substring(0, 10);
    if (fStr >= desde && fStr <= hasta) {
      eliminadas++;
    } else {
      conservar.push(datos[i]);
    }
  }
  Logger.log("Eliminando " + eliminadas + " filas del rango, conservando " + (conservar.length - 1));

  var nuevasFilas = filas.map(function(f) {
    return [f.fecha, f.local, f.sistema, f.producto, f.sku||"", f.color||"", f.talle||"", f.cantidad, f.precioUnit, f.total];
  });
  var dataFinal = conservar.concat(nuevasFilas);

  hoja.clearContents();
  hoja.getRange(1, 1, dataFinal.length, dataFinal[0].length).setValues(dataFinal);
  Logger.log("✅ Total escrito: " + nuevasFilas.length + " filas nuevas para " + desde + " → " + hasta);
}

function _fetchWooRango_(baseUrl, key, secret, desde, hasta, localNombre) {
  var auth = Utilities.base64Encode(key + ":" + secret);
  var headers = { "Authorization": "Basic " + auth };
  var filas = [];
  var page = 1;

  // Calcular día siguiente al hasta para el before
  var dParts = hasta.split("-");
  var dSig = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2])+1));
  var diaSig = Utilities.formatDate(dSig, "UTC", "yyyy-MM-dd");

  while (true) {
    var url = baseUrl + "/wp-json/wc/v3/orders?status=completed,processing&after=" + desde + "T03:00:00Z&before=" + diaSig + "T02:59:59Z&per_page=100&page=" + page;
    var resp = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) break;
    var orders = JSON.parse(resp.getContentText());
    if (!Array.isArray(orders) || orders.length === 0) break;

    orders.forEach(function(order) {
      // Fecha del pedido en Argentina
      var fechaPedido = order.date_created ? order.date_created.substring(0, 10) : desde;
      (order.line_items || []).forEach(function(item) {
        var color = "", talle = "";
        (item.meta_data || []).forEach(function(m) {
          var k = (m.key || "").toLowerCase();
          var v = String(m.value || "");
          if (k === "color" || k === "pa_color" || k === "colour") color = v;
          else if (k === "talle" || k === "size" || k === "pa_talle" || k === "pa_size") talle = v;
        });
        var precioUnit = item.quantity > 0 ? parseFloat(item.total || 0) / item.quantity : 0;
        filas.push({ fecha: fechaPedido, local: localNombre, sistema: "WooCommerce", producto: item.name || "", sku: item.sku || "", color: color, talle: talle, cantidad: parseInt(item.quantity || 1), precioUnit: Math.round(precioUnit), total: parseFloat(item.total || 0) });
      });
    });
    if (orders.length < 100) break;
    page++;
  }
  return filas;
}

function _fetchTNRango_(desde, hasta) {
  var props = PropertiesService.getScriptProperties().getProperties();
  var token = props["TN_ACCESS_TOKEN"]; var userId = props["TN_USER_ID"];
  if (!token || !userId) return [];

  var dSig = hasta.split("-");
  var dSigObj = new Date(Date.UTC(parseInt(dSig[0]), parseInt(dSig[1])-1, parseInt(dSig[2])+1));
  var diaSig = Utilities.formatDate(dSigObj, "UTC", "yyyy-MM-dd");

  var filas = []; var page = 1;
  var inicioUTC = desde  + "T03:00:00+0000";
  var finUTC    = diaSig + "T02:59:59+0000";

  while (true) {
    // SIN filtro payment_status — incluimos todas las órdenes válidas (matchea con el panel TN)
    var url = "https://api.tiendanube.com/v1/" + userId + "/orders?created_at_min=" + inicioUTC + "&created_at_max=" + finUTC + "&per_page=200&page=" + page;
    var resp = UrlFetchApp.fetch(url, { headers: { "Authentication": "bearer " + token, "User-Agent": "TussyApp/1.0" }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) break;
    var orders = JSON.parse(resp.getContentText());
    if (!Array.isArray(orders) || orders.length === 0) break;

    orders.forEach(function(order) {
      // Solo contar órdenes que TN considera ventas reales (excluye pending/abandoned/voided/cancelled)
      var orderStatus = String(order.status || "").toLowerCase();
      var paymentStatus = String(order.payment_status || "").toLowerCase();
      if (orderStatus === "cancelled") return;
      var statusValidos = ["paid", "partially_paid"];
      if (statusValidos.indexOf(paymentStatus) === -1) return;
      var fechaPedido = order.created_at ? order.created_at.substring(0, 10) : desde;
      // Ajustar a Argentina si viene en UTC (restar 3 horas)
      if (order.created_at && order.created_at.indexOf("T") > 0) {
        var d = new Date(order.created_at);
        fechaPedido = Utilities.formatDate(d, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
      }

      // 1) Calcular subtotal de productos para prorratear envío y descuento
      var subtotalProductos = 0;
      (order.products || []).forEach(function(item) {
        var qty = parseInt(item.quantity || 1);
        var precioUnit = parseFloat(item.price || 0);
        subtotalProductos += precioUnit * qty;
      });

      var shipping = parseFloat(order.shipping_cost_customer || order.shipping_cost_owner || 0);
      var descuento = parseFloat(order.discount || 0) + parseFloat(order.discount_coupon || 0) + parseFloat(order.discount_gateway || 0);
      var totalOrden = parseFloat(order.total || 0);

      // 2) Filas por producto (con prorrateo de descuento si aplica)
      (order.products || []).forEach(function(item) {
        var color = "", talle = "";
        var nombreBase = item.name || "";
        if (item.variant && item.variant.values) {
          item.variant.values.forEach(function(v, idx) {
            var nombre = (item.variant.attribute_names || [])[idx] || "";
            var valor = String(v || "");
            if (nombre.toLowerCase().indexOf("color") >= 0) color = valor;
            else if (nombre.toLowerCase().indexOf("talle") >= 0 || nombre.toLowerCase().indexOf("size") >= 0) talle = valor;
            else if (idx === 0 && !color) color = valor;
            else if (idx === 1 && !talle) talle = valor;
          });
        }
        if ((!color || !talle) && nombreBase.indexOf("(") >= 0) {
          var m = nombreBase.match(/\(([^)]+)\)$/);
          if (m) { var p = m[1].split(",").map(function(s){return s.trim();}); if (!color && p[0]) color=p[0]; if (!talle && p[1]) talle=p[1]; nombreBase=nombreBase.replace(/\s*\([^)]+\)$/,"").trim(); }
        }
        var qty = parseInt(item.quantity || 1);
        var precioUnit = parseFloat(item.price || 0);
        var totalItem = precioUnit * qty;
        filas.push({ fecha: fechaPedido, local: "Tiendanube", sistema: "Tiendanube", producto: nombreBase, sku: item.sku||"", color: color, talle: talle, cantidad: qty, precioUnit: Math.round(precioUnit), total: Math.round(totalItem) });
      });

      // 3) Línea de envío (si hay)
      if (shipping > 0) {
        filas.push({ fecha: fechaPedido, local: "Tiendanube", sistema: "Tiendanube", producto: "ENVIO", sku: "", color: "", talle: "", cantidad: 1, precioUnit: Math.round(shipping), total: Math.round(shipping) });
      }

      // 4) Línea de descuento (negativa, si hay)
      if (descuento > 0) {
        filas.push({ fecha: fechaPedido, local: "Tiendanube", sistema: "Tiendanube", producto: "DESCUENTO", sku: "", color: "", talle: "", cantidad: 1, precioUnit: -Math.round(descuento), total: -Math.round(descuento) });
      }

      // 5) Ajuste de redondeo para que el total de la orden coincida exactamente con TN
      var sumaCalculada = subtotalProductos + shipping - descuento;
      var diferencia = totalOrden - sumaCalculada;
      if (Math.abs(diferencia) > 1) {
        filas.push({ fecha: fechaPedido, local: "Tiendanube", sistema: "Tiendanube", producto: "AJUSTE", sku: "", color: "", talle: "", cantidad: 1, precioUnit: Math.round(diferencia), total: Math.round(diferencia) });
      }
    });
    if (orders.length < 200) break;
    page++;
  }
  return filas;
}

function _fetchDFRango_(baseUrl, token, baseDatos, desde, hasta, localNombre) {
  var filas = [];
  var page = 1;
  var idCliente = PropertiesService.getScriptProperties().getProperty("DF_ID_CLIENTE") || "API";

  var dParts = desde.split("-");
  var tsInicio = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2]), 3, 0, 0)).getTime();
  var hParts = hasta.split("-");
  var tsFin = new Date(Date.UTC(parseInt(hParts[0]), parseInt(hParts[1])-1, parseInt(hParts[2])+1, 2, 59, 59)).getTime();

  while (true) {
    var url = baseUrl + "/api.Dragonfish/Facturaagrupada/?limit=50&page=" + page + "&sort=-Fecha";
    var resp = UrlFetchApp.fetch(url, { headers: { "Authorization": token, "idCliente": idCliente, "BaseDeDatos": baseDatos, "Content-Type": "application/json" }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) break;
    var data = JSON.parse(resp.getContentText());
    var resultados = Array.isArray(data) ? data : (data.Resultados || []);
    if (!resultados || resultados.length === 0) break;

    var hayMasViejas = false;
    resultados.forEach(function(fac) {
      var fechaMatch = String(fac.Fecha || "").match(/\/Date\((\d+)/);
      if (!fechaMatch) return;
      var ts = parseInt(fechaMatch[1]);
      if (ts < tsInicio) { hayMasViejas = true; return; }
      if (ts > tsFin) return;
      var fechaStr = Utilities.formatDate(new Date(ts), "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
      (fac.FacturaDetalle || []).forEach(function(item) {
        filas.push({ fecha: fechaStr, local: localNombre, sistema: "Dragonfish", producto: item.ArticuloDetalle || "", sku: item.Articulo || "", color: item.ColorDetalle || "", talle: item.Talle || "", cantidad: parseInt(item.Cantidad || 1), precioUnit: Math.round(parseFloat(item.Precio || 0)), total: Math.round(parseFloat(item.Monto || item.Precio || 0)) });
      });
    });
    if (resultados.length < 50 || hayMasViejas) break;
    page++;
  }
  return filas;
}

// ── Normalización de nombres de productos ──
// Unifica variaciones como "REMERA OVERSIZE DIAMOND" y "REMERA TSSY DIAMONDS" → "REMERA DIAMOND"
// Generaliza a todo el catálogo quitando categoría + modificadores de línea/estilo y singularizando
function _normalizarProducto_(nombre) {
  if (!nombre) return "";

  // Quitar paréntesis y su contenido (ej: "(Negro, L)")
  var sinParen = String(nombre).replace(/\([^)]*\)/g, " ");

  // Normalizar: upper, sin acentos, sólo letras/números/espacios
  var n = sinParen.toUpperCase()
    .replace(/[ÁÀÄÂ]/g,"A").replace(/[ÉÈËÊ]/g,"E").replace(/[ÍÌÏÎ]/g,"I")
    .replace(/[ÓÒÖÔ]/g,"O").replace(/[ÚÙÜÛ]/g,"U").replace(/Ñ/g,"N")
    .replace(/[-_\/\.,;:]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ").trim();

  var CATEGORIAS = ["REMERA","REMERON","POLO","POLERA","PANTALON","PANTALONES","BUZO","CAMPERA",
    "CAMISA","BERMUDA","BERMUDAS","SHORT","SHORTS","VESTIDO","TOP","BOXER","LLAVERO",
    "MUSCULOSA","SWEATER","JEAN","JEANS","CHALECO","CARDIGAN","CHOMBA","BODY",
    "CALZA","CALZAS","FALDA","RIÑONERA","GORRA","MEDIAS","SACO"];

  // Modificadores de estilo/línea/marca/material — NO son modelo
  var IGNORAR = [
    "OVERSIZE","TSSY","TSSYA","BOXY","BAGGY","MUJER","HOMBRE","UNISEX",
    "REGULAR","CLASSIC","CLASSICO","CLASICO","PREMIUM","LIMITED","EDITION","EDICION",
    "ALGODON","GABARDINA","TENCEL","LINO","POLIESTER","RUSTICO","RUSTICA","LISO","LISA",
    "SET","LINE","KIT","PACK","COLECCION","FW","SS","SPRING","SUMMER","FALL","WINTER",
    "NUEVO","NUEVA","NEW","XL","NARANJA","VIOLETA","BEIGE","GRIS","NEGRO","NEGRA",
    "BLANCO","BLANCA","AZUL","ROJO","ROJA","VERDE","AMARILLO","CELESTE","HUESO",
    "MARRON","BORDO","ROSA","LAVANDA","MELANGE","TAUPE","OLIVA","PETROLEO"
  ];

  var palabras = n.split(" ").filter(function(p){ return p; });

  // Extraer categoría (la primera que aparezca en la lista)
  var categoria = "";
  for (var i = 0; i < palabras.length; i++) {
    if (CATEGORIAS.indexOf(palabras[i]) >= 0) { categoria = palabras[i]; break; }
  }

  // Singularizar categoría si corresponde
  var categoriaSing = categoria
    .replace(/ES$/, "")          // JEANS→JEAN, PANTALONES→PANTALON, BERMUDAS→BERMUDA
    .replace(/^(REMERON)$/, "REMERA"); // unificar REMERON con REMERA

  // Recolectar TODAS las palabras distintivas del modelo (mantiene nombres multi-palabra)
  var modelo = [];
  palabras.forEach(function(p) {
    if (!p) return;
    if (CATEGORIAS.indexOf(p) >= 0) return;
    if (IGNORAR.indexOf(p) >= 0) return;
    if (p.length < 2) return;
    // Singularizar (quitar S final si la palabra tiene más de 4 letras)
    if (p.length > 4 && p.endsWith("S") && !p.endsWith("SS") && !p.endsWith("US")) {
      p = p.substring(0, p.length - 1);
    }
    modelo.push(p);
  });

  var modeloStr = modelo.join(" ");
  if (categoriaSing && modeloStr) return categoriaSing + " " + modeloStr;
  if (modeloStr) return modeloStr;
  if (categoriaSing) return categoriaSing;
  return n; // fallback al nombre original limpio
}

// ── Verificador: lista todos los productos y su nombre unificado ──
// Ejecutá esta función manualmente para revisar cómo se agrupan los productos
function generarReporteNormalizacion() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("VentasDetalle");
  if (!hoja) throw new Error("No existe VentasDetalle");

  var datos = hoja.getDataRange().getValues();
  var grupos = {};

  for (var i = 1; i < datos.length; i++) {
    var nombre = datos[i][3];
    if (!nombre) continue;
    var cant = parseInt(datos[i][7] || 0);
    var norm = _normalizarProducto_(nombre);
    if (!grupos[norm]) grupos[norm] = { unidades: 0, variantes: {} };
    if (cant > 0) grupos[norm].unidades += cant;
    grupos[norm].variantes[nombre] = (grupos[norm].variantes[nombre] || 0) + (cant > 0 ? cant : 0);
  }

  var arr = Object.keys(grupos).map(function(k) {
    var g = grupos[k];
    var vars = Object.keys(g.variantes);
    return [k, g.unidades, vars.length, vars.join(" | ")];
  }).sort(function(a, b) { return b[1] - a[1]; });

  var hojaOut = ss.getSheetByName("ProductosNormalizados");
  if (hojaOut) ss.deleteSheet(hojaOut);
  hojaOut = ss.insertSheet("ProductosNormalizados");
  hojaOut.appendRow(["Nombre Unificado", "Unidades Totales", "N° Variantes", "Nombres Originales"]);
  hojaOut.setFrozenRows(1);
  if (arr.length) hojaOut.getRange(2, 1, arr.length, 4).setValues(arr);
  hojaOut.setColumnWidth(4, 500);

  Logger.log("Total grupos: " + arr.length);
  return { ok: true, grupos: arr.length };
}

// ── getVentasDetalle: consulta para el asistente IA ──
function getVentasDetalle(params) {
  var desde = params.desde || _ayerArgStr_();
  var hasta = params.hasta || desde;
  var filtroProducto = (params.producto || "").toLowerCase();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("VentasDetalle");
  if (!hoja) return { filas: [], total: 0, mensaje: "Hoja VentasDetalle no existe aún. Ejecutá guardarVentasDetalleAyer primero." };

  var datos = hoja.getDataRange().getValues();
  var resultado = [];

  for (var i = 1; i < datos.length; i++) {
    var r = datos[i];
    if (!r[0]) continue;
    var f = r[0];
    var fStr = (typeof f === "object" && f && f.getFullYear) ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd") : String(f).substring(0, 10);
    if (fStr < desde || fStr > hasta) continue;

    var fila = {
      fecha: fStr, local: r[1], sistema: r[2], producto: r[3],
      sku: r[4], color: r[5], talle: r[6],
      cantidad: r[7], precioUnit: r[8], total: r[9]
    };

    if (filtroProducto && fila.producto.toLowerCase().indexOf(filtroProducto) < 0) continue;
    fila.productoNorm = _normalizarProducto_(fila.producto);
    resultado.push(fila);
  }

  // Agregar resumen por PRODUCTO NORMALIZADO + color (unifica variaciones de nombre)
  var resumen = {};
  resultado.forEach(function(r) {
    var key = [r.productoNorm, r.color].join("|");
    if (!resumen[key]) resumen[key] = {
      producto: r.productoNorm, color: r.color,
      cantidad: 0, cambios: 0, total: 0,
      locales: {}, talles: {}, variantes: {}
    };
    if (r.cantidad < 0) {
      resumen[key].cambios += Math.abs(r.cantidad);
    } else {
      resumen[key].cantidad += r.cantidad;
      resumen[key].total += r.total;
      resumen[key].locales[r.local] = (resumen[key].locales[r.local] || 0) + r.cantidad;
      if (r.talle) resumen[key].talles[r.talle] = (resumen[key].talles[r.talle] || 0) + r.cantidad;
      // Guardar el nombre original más frecuente para referencia
      resumen[key].variantes[r.producto] = (resumen[key].variantes[r.producto] || 0) + r.cantidad;
    }
  });

  // Quedarnos con el nombre original más vendido como "variante principal"
  Object.values(resumen).forEach(function(g) {
    var maxVar = "", maxQty = 0;
    Object.keys(g.variantes).forEach(function(k) {
      if (g.variantes[k] > maxQty) { maxQty = g.variantes[k]; maxVar = k; }
    });
    g.variantePrincipal = maxVar;
    delete g.variantes; // limpiar para respuesta más liviana
  });

  var resumenArr = Object.values(resumen).sort(function(a, b) { return b.cantidad - a.cantidad; });

  return {
    desde: desde,
    hasta: hasta,
    totalFilas: resultado.length,
    resumen: resumenArr.slice(0, 100)
  };
}

// ── buscarStockUnificado: busca stock por nombre normalizado en StockActual ──
// Ej: "Bermuda Scout" matchea con "BERMUDA GABARDINA SCOUT", "BERMUDA SCOUT TSSY", etc.
function buscarStockUnificado(params) {
  var query = (params.query || "").toString().trim();
  if (!query) return { error: "Falta query" };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("StockActual");
  if (!hoja) return { error: "No existe StockActual. Ejecutá actualizarStockSnapshot." };

  var datos = hoja.getDataRange().getValues();
  if (datos.length < 2) return { resultados: [], mensaje: "StockActual vacío" };

  // Header esperado: Nombre | Palermo | LaPlata | Dot | Abasto | Cordoba | Total
  // Buscar índices por header
  var header = datos[0].map(function(h) { return String(h || "").toLowerCase(); });
  var idxNombre  = header.indexOf("nombre");
  if (idxNombre < 0) idxNombre = 0;

  // Normalizar el query del usuario
  var queryNorm = _normalizarProducto_(query);
  // Tokens del query normalizado para matching parcial
  var queryTokens = queryNorm.split(" ").filter(function(t) { return t.length >= 3; });

  var resultados = {};

  for (var i = 1; i < datos.length; i++) {
    var r = datos[i];
    var nombre = r[idxNombre];
    if (!nombre) continue;

    var nombreNorm = _normalizarProducto_(nombre);

    // Match si TODOS los tokens del query están en el nombre normalizado
    var match = queryTokens.length > 0 && queryTokens.every(function(t) {
      return nombreNorm.indexOf(t) >= 0;
    });
    if (!match) continue;

    // Agregar al grupo unificado
    if (!resultados[nombreNorm]) {
      resultados[nombreNorm] = {
        producto: nombreNorm,
        stockPorLocal: { palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0 },
        total: 0,
        variantes: {}
      };
    }
    var g = resultados[nombreNorm];
    g.stockPorLocal.palermo += parseInt(r[1] || 0);
    g.stockPorLocal.laplata += parseInt(r[2] || 0);
    g.stockPorLocal.dot     += parseInt(r[3] || 0);
    g.stockPorLocal.abasto  += parseInt(r[4] || 0);
    g.stockPorLocal.cordoba += parseInt(r[5] || 0);
    g.variantes[nombre] = (g.variantes[nombre] || 0) + parseInt(r[6] || 0);
  }

  var arr = Object.values(resultados).map(function(g) {
    g.total = g.stockPorLocal.palermo + g.stockPorLocal.laplata + g.stockPorLocal.dot + g.stockPorLocal.abasto + g.stockPorLocal.cordoba;
    g.nombresOriginales = Object.keys(g.variantes);
    delete g.variantes;
    return g;
  }).sort(function(a, b) { return b.total - a.total; });

  return { query: query, queryNormalizado: queryNorm, resultados: arr };
}

// ── getStockValorizado: devuelve valor total del inventario por local ──
function getStockValorizado(params) {
  params = params || {};
  var filtroNombre = (params.query || "").toString().trim();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("StockActual");
  if (!hoja) return { error: "No existe StockActual. Ejecutá actualizarStockSnapshot." };

  var datos = hoja.getDataRange().getValues();
  if (datos.length < 2) return { error: "StockActual vacío" };

  var header = datos[0].map(function(h) { return String(h || "").toLowerCase(); });
  var idxNombre = header.indexOf("producto"); if (idxNombre < 0) idxNombre = 0;
  var idxPalermo = 1, idxLaPlata = 2, idxDot = 3, idxAbasto = 4, idxCordoba = 5;
  var idxPrecio = header.indexOf("precio");
  var idxValorizado = header.indexOf("valorizado");

  if (idxPrecio < 0) {
    return { error: "La columna Precio no existe. Ejecutá actualizarStockSnapshot con la nueva versión." };
  }

  var totales = { palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0 };
  var unidades = { palermo: 0, laplata: 0, dot: 0, abasto: 0, cordoba: 0 };
  var productosSinPrecio = 0;
  var topProductos = [];

  var queryNorm = filtroNombre ? _normalizarProducto_(filtroNombre) : "";
  var queryTokens = queryNorm ? queryNorm.split(" ").filter(function(t) { return t.length >= 3; }) : [];

  for (var i = 1; i < datos.length; i++) {
    var r = datos[i];
    var nombre = r[idxNombre];
    if (!nombre) continue;

    // Filtrar si hay query
    if (queryTokens.length > 0) {
      var nombreNorm = _normalizarProducto_(nombre);
      var match = queryTokens.every(function(t) { return nombreNorm.indexOf(t) >= 0; });
      if (!match) continue;
    }

    var pal = parseInt(r[idxPalermo] || 0);
    var lap = parseInt(r[idxLaPlata] || 0);
    var dot = parseInt(r[idxDot] || 0);
    var aba = parseInt(r[idxAbasto] || 0);
    var cor = parseInt(r[idxCordoba] || 0);
    var precio = parseFloat(r[idxPrecio] || 0);

    unidades.palermo += pal; unidades.laplata += lap; unidades.dot += dot; unidades.abasto += aba; unidades.cordoba += cor;

    if (precio <= 0) {
      productosSinPrecio++;
      continue;
    }

    totales.palermo += pal * precio;
    totales.laplata += lap * precio;
    totales.dot += dot * precio;
    totales.abasto += aba * precio;
    totales.cordoba += cor * precio;

    var valProducto = (pal + lap + dot + aba + cor) * precio;
    if (valProducto > 0) {
      topProductos.push({
        nombre: nombre,
        unidades: pal + lap + dot + aba + cor,
        precio: precio,
        valorizado: Math.round(valProducto)
      });
    }
  }

  topProductos.sort(function(a, b) { return b.valorizado - a.valorizado; });

  var totalGlobal = totales.palermo + totales.laplata + totales.dot + totales.abasto + totales.cordoba;
  var unidadesTotal = unidades.palermo + unidades.laplata + unidades.dot + unidades.abasto + unidades.cordoba;

  return {
    filtro: filtroNombre || "TODOS",
    totalValorizado: Math.round(totalGlobal),
    totalUnidades: unidadesTotal,
    porLocal: {
      palermo: { unidades: unidades.palermo, valorizado: Math.round(totales.palermo) },
      laplata: { unidades: unidades.laplata, valorizado: Math.round(totales.laplata) },
      dot: { unidades: unidades.dot, valorizado: Math.round(totales.dot) },
      abasto: { unidades: unidades.abasto, valorizado: Math.round(totales.abasto) },
      cordoba: { unidades: unidades.cordoba, valorizado: Math.round(totales.cordoba) }
    },
    productosSinPrecio: productosSinPrecio,
    top20: topProductos.slice(0, 20)
  };
}

// ── corregirTiendanubeRango: re-procesa SOLO Tiendanube, sin tocar WC ni DF ──
// Útil cuando hay transferencias confirmadas tarde que quedaron sin cargar
// Uso: corregirTiendanubeRango("2026-04-01", "2026-04-29")
function corregirTiendanubeRango(desde, hasta) {
  if (!desde) desde = "2026-04-01";
  if (!hasta) hasta = _ayerArgStr_();
  Logger.log("Corrigiendo Tiendanube: " + desde + " → " + hasta);

  // Traer todas las órdenes de TN del rango (paid)
  var filasTN;
  try {
    filasTN = _fetchTNRango_(desde, hasta);
    Logger.log("Tiendanube: " + filasTN.length + " filas obtenidas");
  } catch(e) {
    Logger.log("Error TN: " + e.message);
    return { error: e.message };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("VentasDetalle");
  if (!hoja) return { error: "No existe VentasDetalle" };

  // Leer todo de una y filtrar (es 100x más rápido que deleteRow uno por uno)
  var datos = hoja.getDataRange().getValues();
  var header = datos[0];
  var conservar = [header];
  var eliminadas = 0;
  for (var i = 1; i < datos.length; i++) {
    var f = datos[i][0];
    var sistema = String(datos[i][2] || "");
    var fStr = (typeof f === "object" && f && f.getFullYear)
      ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(f).substring(0, 10);
    if (sistema === "Tiendanube" && fStr >= desde && fStr <= hasta) {
      eliminadas++;
    } else {
      conservar.push(datos[i]);
    }
  }
  Logger.log("Filtrando: " + eliminadas + " filas viejas de TN se eliminan, " + (conservar.length - 1) + " se conservan");

  // Agregar las nuevas filas TN al array
  var nuevasFilas = filasTN.map(function(f) {
    return [f.fecha, f.local, f.sistema, f.producto, f.sku || "", f.color || "", f.talle || "", f.cantidad, f.precioUnit, f.total];
  });
  var dataFinal = conservar.concat(nuevasFilas);

  // Reescribir hoja completa de una sola operación (rapidísimo)
  hoja.clearContents();
  hoja.getRange(1, 1, dataFinal.length, dataFinal[0].length).setValues(dataFinal);

  return { ok: true, eliminadas: eliminadas, agregadas: nuevasFilas.length, totalFilas: dataFinal.length - 1 };
}

// ── Recalcular VentasDiarias desde VentasDetalle para un rango de fechas ──
// Útil para corregir totales históricos cuando VentasDetalle se actualiza con data faltante.
// Uso: sincronizarVentasDiariasDesdeDetalle("2026-04-01", "2026-04-28")
function sincronizarVentasDiariasDesdeDetalle(desde, hasta) {
  if (!desde) desde = "2026-04-01";
  if (!hasta) hasta = _ayerArgStr_();
  Logger.log("Sincronizando VentasDiarias: " + desde + " → " + hasta);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hojaDetalle = ss.getSheetByName("VentasDetalle");
  if (!hojaDetalle) return { error: "No existe VentasDetalle" };

  var datos = hojaDetalle.getDataRange().getValues();

  // Mapear "Local" → key de VentasDiarias
  var mapaLocales = {
    "Palermo": "palermo",
    "La Plata": "laplata",
    "Tiendanube": "online",
    "Dot": "dot",
    "Abasto": "abasto",
    "Córdoba": "cordoba",
    "Cordoba": "cordoba"
  };

  // Acumular por fecha + local: { "2026-04-01": { palermo: {total:0, ops:0}, ... } }
  var porDia = {};
  var ordenesUnicasPorDia = {}; // para contar "ops" únicos por orden (no por línea)

  for (var i = 1; i < datos.length; i++) {
    var f = datos[i][0];
    var local = String(datos[i][1] || "");
    var producto = String(datos[i][3] || "");
    var total = parseFloat(datos[i][9] || 0);

    var fStr = (typeof f === "object" && f && f.getFullYear)
      ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(f).substring(0, 10);

    if (fStr < desde || fStr > hasta) continue;
    if (!mapaLocales[local]) continue;

    var key = mapaLocales[local];
    if (!porDia[fStr]) porDia[fStr] = {};
    if (!porDia[fStr][key]) porDia[fStr][key] = { total: 0, lineas: 0 };
    porDia[fStr][key].total += total;
    // Contar líneas que NO son ENVIO/DESCUENTO/AJUSTE como proxy de items (luego ajustamos a "órdenes")
    if (producto !== "ENVIO" && producto !== "DESCUENTO" && producto !== "AJUSTE") {
      porDia[fStr][key].lineas += 1;
    }
  }

  // Para cada fecha, llamar a guardarVentaDiaria con los totales calculados.
  // Si un local tiene un error NO resuelto en SyncErrors para esa fecha, pasamos null
  // en vez del total agregado (que sería 0 por falta de filas) → así mergeVal preserva
  // el valor previo y no pisa con 0.
  var erroresPorFecha = _cargarErroresNoResueltosPorFecha_();
  var fechas = Object.keys(porDia).sort();
  var actualizadas = 0;
  fechas.forEach(function(fecha) {
    var d = porDia[fecha];
    var errs = erroresPorFecha[fecha] || {};
    var params = {
      fecha: fecha,
      palermo:    errs["Palermo"]    ? null : Math.round((d.palermo && d.palermo.total) || 0),
      laplata:    errs["La Plata"]   ? null : Math.round((d.laplata && d.laplata.total) || 0),
      online:     errs["Tiendanube"] ? null : Math.round((d.online  && d.online.total)  || 0),
      dot:        errs["Dot"]        ? null : Math.round((d.dot     && d.dot.total)     || 0),
      abasto:     errs["Abasto"]     ? null : Math.round((d.abasto  && d.abasto.total)  || 0),
      cordoba:    (errs["Córdoba"] || errs["Cordoba"]) ? null : Math.round((d.cordoba && d.cordoba.total) || 0),
      opsPalermo: errs["Palermo"]    ? null : ((d.palermo && d.palermo.lineas) || 0),
      opsLaPlata: errs["La Plata"]   ? null : ((d.laplata && d.laplata.lineas) || 0),
      opsOnline:  errs["Tiendanube"] ? null : ((d.online  && d.online.lineas)  || 0),
      opsDot:     errs["Dot"]        ? null : ((d.dot     && d.dot.lineas)     || 0),
      opsAbasto:  errs["Abasto"]     ? null : ((d.abasto  && d.abasto.lineas)  || 0),
      opsCordoba: (errs["Córdoba"] || errs["Cordoba"]) ? null : ((d.cordoba && d.cordoba.lineas) || 0)
    };
    guardarVentaDiaria(params);
    actualizadas++;
    Logger.log(fecha + " → online: $" + params.online);
  });

  return { ok: true, fechasActualizadas: actualizadas, primera: fechas[0], ultima: fechas[fechas.length-1] };
}

// ── Sincronizar SOLO la columna "online" (TN) en VentasDiarias desde VentasDetalle ──
// Preserva todos los demás locales tal como están.
function sincronizarSoloTNDesdeDetalle(desde, hasta) {
  if (!desde) desde = "2026-04-01";
  if (!hasta) hasta = _ayerArgStr_();
  Logger.log("Sincronizando SOLO TN (online): " + desde + " → " + hasta);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hojaDetalle = ss.getSheetByName("VentasDetalle");
  if (!hojaDetalle) return { error: "No existe VentasDetalle" };
  var hojaDiarias = ss.getSheetByName("VentasDiarias");
  if (!hojaDiarias) return { error: "No existe VentasDiarias" };

  // Acumular totales de TN por día desde VentasDetalle
  var datos = hojaDetalle.getDataRange().getValues();
  var totalesPorDia = {};
  var lineasPorDia = {};
  for (var i = 1; i < datos.length; i++) {
    var sistema = String(datos[i][2] || "");
    if (sistema !== "Tiendanube") continue;
    var f = datos[i][0];
    var producto = String(datos[i][3] || "");
    var total = parseFloat(datos[i][9] || 0);
    var fStr = (typeof f === "object" && f && f.getFullYear)
      ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(f).substring(0, 10);
    if (fStr < desde || fStr > hasta) continue;
    totalesPorDia[fStr] = (totalesPorDia[fStr] || 0) + total;
    if (producto !== "ENVIO" && producto !== "DESCUENTO" && producto !== "AJUSTE") {
      lineasPorDia[fStr] = (lineasPorDia[fStr] || 0) + 1;
    }
  }

  // Leer VentasDiarias y modificar SOLO las columnas online (col 4) y opsOnline (col 10)
  var diarias = hojaDiarias.getDataRange().getValues();
  Logger.log("VentasDetalle TN: fechas con data = " + Object.keys(totalesPorDia).length);
  Logger.log("VentasDiarias: total filas = " + (diarias.length - 1));

  var actualizadas = 0;
  var fechasNoEncontradas = Object.keys(totalesPorDia).slice();
  for (var j = 1; j < diarias.length; j++) {
    var f = diarias[j][0];
    var fStr = (typeof f === "object" && f && f.getFullYear)
      ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(f).substring(0, 10);
    if (fStr < desde || fStr > hasta) continue;
    if (totalesPorDia[fStr] !== undefined) {
      hojaDiarias.getRange(j + 1, 4).setValue(Math.round(totalesPorDia[fStr]));
      hojaDiarias.getRange(j + 1, 10).setValue(lineasPorDia[fStr] || 0);
      actualizadas++;
      var idx = fechasNoEncontradas.indexOf(fStr);
      if (idx >= 0) fechasNoEncontradas.splice(idx, 1);
      Logger.log(fStr + " → online: $" + Math.round(totalesPorDia[fStr]));
    }
  }

  Logger.log("✅ Actualizadas: " + actualizadas);
  if (fechasNoEncontradas.length > 0) {
    Logger.log("⚠️ Fechas en VentasDetalle que NO existen en VentasDiarias: " + fechasNoEncontradas.join(", "));
  }

  return { ok: true, actualizadas: actualizadas, fechasProcesadas: Object.keys(totalesPorDia).length, faltantes: fechasNoEncontradas };
}

// ── Backfill completo de VentasDiarias para un rango (llama a las APIs en vivo) ──
// Reconstituye lo que el cron de resumen-diario hace cada día.
function backfillVentasDiarias(desde, hasta) {
  if (!desde) desde = "2026-04-01";
  if (!hasta) hasta = _ayerArgStr_();

  var BASE = "https://app.gestiontussy.com.ar";
  Logger.log("Backfill VentasDiarias: " + desde + " → " + hasta);

  var inicio = new Date(desde + "T12:00:00Z");
  var fin = new Date(hasta + "T12:00:00Z");
  var tInicio = new Date().getTime();
  var LIMITE_MS = 5 * 60 * 1000;

  var procesadas = [];
  var errores = [];
  var actual = new Date(inicio);

  while (actual <= fin) {
    if (new Date().getTime() - tInicio > LIMITE_MS) {
      var fStr = Utilities.formatDate(actual, "UTC", "yyyy-MM-dd");
      Logger.log("⚠️ Límite tiempo. Retomá desde: backfillVentasDiarias(\"" + fStr + "\", \"" + hasta + "\")");
      break;
    }

    var fecha = Utilities.formatDate(actual, "UTC", "yyyy-MM-dd");
    try {
      // Llamar a /api/ventas (Palermo, La Plata, TN) — si falla, v = null (preserva data anterior)
      var v = null;
      try {
        var ventasResp = UrlFetchApp.fetch(BASE + "/api/ventas?desde=" + fecha + "&hasta=" + fecha, {
          muteHttpExceptions: true
        });
        if (ventasResp.getResponseCode() === 200) {
          v = JSON.parse(ventasResp.getContentText());
        }
      } catch(eWoo) { Logger.log(fecha + " ⚠️ ventas API: " + eWoo.message); }

      // Llamar a /api/dragonfish?action=ventas — si falla, df = null
      var df = null;
      try {
        var dfResp = UrlFetchApp.fetch(BASE + "/api/dragonfish?action=ventas&desde=" + fecha + "&hasta=" + fecha, {
          muteHttpExceptions: true
        });
        if (dfResp.getResponseCode() === 200) {
          df = JSON.parse(dfResp.getContentText());
        }
      } catch(eDF) { Logger.log(fecha + " ⚠️ dragonfish API: " + eDF.message); }

      // Helper: devuelve null si la fuente falló o el campo no existe (para preservar valor anterior)
      function safe(obj, k1, k2) {
        if (!obj) return null;
        if (!obj[k1]) return null;
        var val = obj[k1][k2];
        return (val === undefined || val === null) ? null : val;
      }

      var params = {
        fecha: fecha,
        palermo:    safe(v,  'palermo',   'total'),
        laplata:    safe(v,  'laplata',   'total'),
        online:     safe(v,  'tiendanube','total'),
        dot:        safe(df, 'dot',       'total'),
        abasto:     safe(df, 'abasto',    'total'),
        cordoba:    safe(df, 'cordoba',   'total'),
        opsPalermo: safe(v,  'palermo',   'cantidad'),
        opsLaPlata: safe(v,  'laplata',   'cantidad'),
        opsOnline:  safe(v,  'tiendanube','cantidad'),
        opsDot:     safe(df, 'dot',       'cantidad'),
        opsAbasto:  safe(df, 'abasto',    'cantidad'),
        opsCordoba: safe(df, 'cordoba',   'cantidad')
      };
      guardarVentaDiaria(params);

      // Resumir qué se trajo de cada fuente
      var fuentes = [];
      if (v) fuentes.push("WC/TN ✓"); else fuentes.push("WC/TN ✗");
      if (df) fuentes.push("DF ✓"); else fuentes.push("DF ✗");
      var totalLog = (params.palermo||0)+(params.laplata||0)+(params.online||0)+(params.dot||0)+(params.abasto||0)+(params.cordoba||0);
      Logger.log(fecha + " " + fuentes.join(" | ") + " Total nuevo: $" + totalLog);
      procesadas.push(fecha);
    } catch(e) {
      Logger.log(fecha + " ❌ " + e.message);
      errores.push({ fecha: fecha, error: e.message });
    }

    actual.setUTCDate(actual.getUTCDate() + 1);
  }

  return { ok: true, procesadas: procesadas.length, errores: errores.length, primera: procesadas[0], ultima: procesadas[procesadas.length-1] };
}

// ── Backfill de UN solo local (Dragonfish) ──
// Útil si timeoutea backfillRango y querés cargar solo el local que faltó.
// Borra solo las filas de ese local en el rango y agrega las nuevas.
function backfillUnLocalDF(localKey, desde, hasta) {
  if (!desde) desde = "2026-04-01";
  if (!hasta) hasta = _ayerArgStr_();
  if (!localKey) return { error: "Falta localKey (dot, abasto, cordoba)" };

  var props = PropertiesService.getScriptProperties().getProperties();
  var configs = {
    dot:     { nombre: "Dot",     url: props["DF_DOT_URL"],     token: props["DF_JWTOKEN_DOT"],     bd: props["DF_BASE_DATOS_DOT"]     || "DOT" },
    abasto:  { nombre: "Abasto",  url: props["DF_ABASTO_URL"],  token: props["DF_JWTOKEN_ABASTO"],  bd: props["DF_BASE_DATOS_ABASTO"]  || "ABASTO" },
    cordoba: { nombre: "Córdoba", url: props["DF_CORDOBA_URL"], token: props["DF_JWTOKEN_CORDOBA"], bd: props["DF_BASE_DATOS_CORDOBA"] || "CORDOBA" }
  };
  var cfg = configs[localKey.toLowerCase()];
  if (!cfg) return { error: "Local desconocido. Usá: dot, abasto, cordoba" };
  if (!cfg.url || !cfg.token) return { error: "Sin credenciales para " + cfg.nombre };

  Logger.log("Backfill " + cfg.nombre + ": " + desde + " → " + hasta);

  var filas;
  try {
    filas = _fetchDFRango_(cfg.url, cfg.token, cfg.bd, desde, hasta, cfg.nombre);
    Logger.log(cfg.nombre + " DF: " + filas.length + " filas obtenidas");
  } catch(e) {
    return { error: "Error fetch DF: " + e.message };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("VentasDetalle");
  if (!hoja) return { error: "No existe VentasDetalle" };

  // Filtrar filas: conservar todas las que NO sean de este local en el rango
  var datos = hoja.getDataRange().getValues();
  var header = datos[0];
  var conservar = [header];
  var eliminadas = 0;
  for (var i = 1; i < datos.length; i++) {
    var f = datos[i][0];
    var local = String(datos[i][1] || "");
    var fStr = (typeof f === "object" && f.getFullYear) ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd") : String(f).substring(0, 10);
    if (local === cfg.nombre && fStr >= desde && fStr <= hasta) {
      eliminadas++;
    } else {
      conservar.push(datos[i]);
    }
  }

  var nuevasFilas = filas.map(function(f) {
    return [f.fecha, f.local, f.sistema, f.producto, f.sku||"", f.color||"", f.talle||"", f.cantidad, f.precioUnit, f.total];
  });
  var dataFinal = conservar.concat(nuevasFilas);

  hoja.clearContents();
  hoja.getRange(1, 1, dataFinal.length, dataFinal[0].length).setValues(dataFinal);

  return { ok: true, local: cfg.nombre, eliminadas: eliminadas, agregadas: nuevasFilas.length };
}

// ── Diagnóstico de VentasDetalle ──
function diagnosticoVentasDetalle() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var info = {
    spreadsheet_name: ss.getName(),
    spreadsheet_id: ss.getId(),
    spreadsheet_url: ss.getUrl(),
    sheets: []
  };
  ss.getSheets().forEach(function(s) {
    info.sheets.push({
      name: s.getName(),
      lastRow: s.getLastRow(),
      lastCol: s.getLastColumn(),
      firstRowData: s.getLastRow() > 0 ? s.getRange(1, 1, 1, Math.min(s.getLastColumn(), 5)).getValues()[0] : []
    });
  });
  Logger.log(JSON.stringify(info, null, 2));
  return info;
}

// ── Diagnóstico: muestra valores únicos en columna Local de VentasDetalle ──
function diagLocalesEnDetalle() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName("VentasDetalle");
  var datos = hoja.getDataRange().getValues();
  var counts = {};
  var totalPorLocal = {};
  for (var i = 1; i < datos.length; i++) {
    var local = String(datos[i][1] || "");
    var total = parseFloat(datos[i][9] || 0);
    counts[local] = (counts[local] || 0) + 1;
    totalPorLocal[local] = (totalPorLocal[local] || 0) + total;
  }
  Object.keys(counts).forEach(function(l) {
    Logger.log("Local: '" + l + "' → " + counts[l] + " filas, $" + Math.round(totalPorLocal[l]));
  });
  return { counts: counts, totales: totalPorLocal };
}

// ══════════════════════════════════════════════════════
// HEALTH-CHECK VentasDiarias: alerta por email si algún local
// quedó en 0 o cayó abruptamente vs promedio histórico.
//
// Configuración (Script Properties):
//   ALERT_EMAIL           → destinatario (obligatorio). Ej: "vos@dominio.com"
//   ALERT_UMBRAL_PCT      → % del promedio bajo el cual dispara alerta (default 30 = 30%)
//   ALERT_MIN_PROMEDIO    → monto mínimo del promedio para considerar el local activo
//                           (default 5000 — evita falsos positivos en locales chicos)
//
// Trigger sugerido: cada día 10:00 AM (America/Argentina/Buenos_Aires)
//   Editor Apps Script → Activadores → validarVentasAyer → Diario 10-11 hs
// ══════════════════════════════════════════════════════
function validarVentasAyer() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var email = props["ALERT_EMAIL"];
  if (!email) {
    Logger.log("⚠️ Falta Script Property ALERT_EMAIL. No se envía alerta.");
    return { ok: false, error: "ALERT_EMAIL no configurado" };
  }
  var umbralPct    = parseFloat(props["ALERT_UMBRAL_PCT"] || "30") / 100;
  var minPromedio  = parseFloat(props["ALERT_MIN_PROMEDIO"] || "5000");

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("VentasDiarias");
  if (!sheet) return { ok: false, error: "No existe VentasDiarias" };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: false, error: "VentasDiarias vacía" };

  // Locales a validar: col index en VentasDiarias
  var locales = [
    { key: "palermo",  nombre: "Palermo",  col: 1 },
    { key: "laplata",  nombre: "LaPlata",  col: 2 },
    { key: "online",   nombre: "Online",   col: 3 },
    { key: "dot",      nombre: "Dot",      col: 4 },
    { key: "abasto",   nombre: "Abasto",   col: 5 },
    { key: "cordoba",  nombre: "Córdoba",  col: 6 }
  ];

  var fechaAyer = _ayerArgStr_();

  // Buscar fila de ayer
  var filaAyer = null;
  for (var i = data.length - 1; i >= 1; i--) {
    var f = data[i][0];
    var fStr = (typeof f === "object" && f && f.getFullYear)
      ? Utilities.formatDate(f, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(f).substring(0, 10);
    if (fStr === fechaAyer) { filaAyer = data[i]; break; }
  }

  if (!filaAyer) {
    var asuntoFalta = "⚠️ VentasDiarias: no hay fila para " + fechaAyer;
    MailApp.sendEmail(email, asuntoFalta,
      "No se encontró ninguna fila con fecha " + fechaAyer + " en VentasDiarias.\n" +
      "Probablemente falló el trigger diario de guardarVentasDetalleAyer.");
    return { ok: false, alerta: "sin_fila_ayer" };
  }

  // Fecha ayer como objeto para calcular día de la semana
  var dowAyer = new Date(fechaAyer + "T12:00:00-03:00").getDay();

  // Calcular promedio por local usando los últimos 14 registros del MISMO día de la semana
  // (excluyendo la fila de ayer misma)
  var muestrasPorLocal = {};
  locales.forEach(function(l) { muestrasPorLocal[l.key] = []; });

  for (var j = data.length - 1; j >= 1; j--) {
    var fx = data[j][0];
    var fxStr = (typeof fx === "object" && fx && fx.getFullYear)
      ? Utilities.formatDate(fx, "America/Argentina/Buenos_Aires", "yyyy-MM-dd")
      : String(fx).substring(0, 10);
    if (fxStr === fechaAyer) continue;
    var dowFila = new Date(fxStr + "T12:00:00-03:00").getDay();
    if (dowFila !== dowAyer) continue;

    var completo = true;
    locales.forEach(function(l) {
      var v = Number(data[j][l.col]) || 0;
      muestrasPorLocal[l.key].push(v);
    });
    // Cortamos cuando ya juntamos 8 muestras del mismo DoW (8 semanas ≈ 2 meses)
    if (muestrasPorLocal[locales[0].key].length >= 8) break;
  }

  var alertas = [];
  locales.forEach(function(l) {
    var valorAyer = Number(filaAyer[l.col]) || 0;
    var muestras  = muestrasPorLocal[l.key];
    if (muestras.length < 3) return; // sin base histórica suficiente
    var suma = muestras.reduce(function(a, b) { return a + b; }, 0);
    var promedio = suma / muestras.length;

    // Local considerado "chico" → no alertar
    if (promedio < minPromedio) return;

    if (valorAyer === 0) {
      alertas.push({
        local: l.nombre,
        valorAyer: 0,
        promedio: Math.round(promedio),
        muestras: muestras.length,
        motivo: "en_cero"
      });
    } else if (valorAyer < promedio * umbralPct) {
      alertas.push({
        local: l.nombre,
        valorAyer: Math.round(valorAyer),
        promedio: Math.round(promedio),
        muestras: muestras.length,
        motivo: "caida_abrupta"
      });
    }
  });

  if (alertas.length === 0) {
    Logger.log("✅ Health-check OK para " + fechaAyer);
    return { ok: true, fecha: fechaAyer, alertas: [] };
  }

  // Armar email
  var lineas = alertas.map(function(a) {
    var pct = a.promedio > 0 ? Math.round((a.valorAyer / a.promedio) * 100) : 0;
    return "• " + a.local + ": $" + a.valorAyer.toLocaleString("es-AR") +
           " (promedio mismo día semana: $" + a.promedio.toLocaleString("es-AR") +
           " sobre " + a.muestras + " muestras — " + pct + "%) — " + a.motivo;
  });

  var cuerpo =
    "Alerta VentasDiarias — fecha " + fechaAyer + "\n\n" +
    "Los siguientes locales tienen valores sospechosos:\n\n" +
    lineas.join("\n") +
    "\n\nRevisá:\n" +
    "1) Logs de Apps Script → Ejecuciones → guardarVentasDetalleAyer\n" +
    "2) Script Properties del local afectado (URL / JWT / BaseDeDatos)\n" +
    "3) Si el token venció, renovarlo y correr:\n" +
    "   guardarVentasDetalle({ fecha: \"" + fechaAyer + "\" })\n" +
    "   sincronizarVentasDiariasDesdeDetalle(\"" + fechaAyer + "\", \"" + fechaAyer + "\")\n";

  MailApp.sendEmail(email, "⚠️ VentasDiarias " + fechaAyer + ": " + alertas.length + " local(es) con anomalía", cuerpo);
  Logger.log("📧 Alerta enviada a " + email + " — " + alertas.length + " local(es)");

  return { ok: false, fecha: fechaAyer, alertas: alertas };
}
