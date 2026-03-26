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
    var novedad = {
      idx: i + 1,
      fecha: formatDate(row[0]),
      local: row[1],
      creadoPor: row[2],
      tipo: row[3],
      descripcion: row[4],
      estado: row[5] || "Pendiente",
      completadoPor: row[6] || ""
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
    sheet.appendRow(["Fecha", "Local", "CreadoPor", "Tipo", "Descripcion", "Estado", "CompletadoPor"]);
  }

  var fecha = new Date().toISOString().split("T")[0];

  sheet.appendRow([
    fecha,
    params.local || "",
    params.creadoPor || "",
    params.tipo || "Novedad",
    params.descripcion || "",
    "Pendiente",
    ""
  ]);

  return { ok: true };
}

function actualizarEstado(params) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Novedades");
  if (!sheet) return { error: "Hoja no encontrada" };

  var idx = parseInt(params.idx);
  if (!idx || idx < 2) return { error: "Index invalido" };

  // Columna F = Estado (col 6), G = CompletadoPor (col 7)
  sheet.getRange(idx, 6).setValue(params.estado || "Completado");
  sheet.getRange(idx, 7).setValue(params.completadoPor || "");

  return { ok: true };
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
