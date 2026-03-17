function doGet(e) {
  const action = e.parameter.action;
  const params = e.parameter.params ? JSON.parse(e.parameter.params) : {};

  let result;
  try {
    if (action === "getCategorias")
      result = getCategorias();
    else if (action === "getDashboard")
      result = getDashboard(params.mes, params.anio);
    else if (action === "agregarTransaccion")
      result = agregarTransaccion(params);
    else
      result = { error: "Accion no encontrada" };
  } catch(err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
