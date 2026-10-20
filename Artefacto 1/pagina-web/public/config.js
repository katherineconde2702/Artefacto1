(function configureTry(global) {
  const previous = global.TRY_CONFIG || {};
  const scriptUrl = document.currentScript?.src || new URL('./config.js', document.baseURI).href;

  global.TRY_CONFIG = Object.freeze({
    ...previous,
    // Cambiá solo este valor cuando la API esté desplegada.
    apiBase: previous.apiBase || 'http://127.0.0.1:8787',
    // Permite que las imágenes sigan funcionando en subcarpetas y GitHub Pages.
    assetBase: previous.assetBase || new URL('./', scriptUrl).href
  });
})(globalThis);
