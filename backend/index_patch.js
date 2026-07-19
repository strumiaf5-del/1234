// ═══════════════════════════════════════════════════════════════════
// PARCHE index.html — soporte de session_id para caché de audio
// Aplicar los cambios indicados con "// CAMBIO" en index.html
// ═══════════════════════════════════════════════════════════════════

// ── 1. Agregar la variable junto a las otras variables de estado ──────────────
// (cerca de "let selectedFile = null;")

let _previewSessionId = null;   // UUID que identifica el archivo actual en el caché del servidor


// ── 2. En la función setFile(f), DESPUÉS de "selectedFile = f" ───────────────
// agregar:

_previewSessionId = crypto.randomUUID();   // nuevo ID → servidor descarta caché anterior


// ── 3. En runLivePreview(), en ws.onopen, ANTES de ws.send(JSON.stringify(cfg)) ──
// agregar la clave al objeto cfg:

cfg.session_id = _previewSessionId;        // para que el servidor identifique la sesión


// ── 4. En ws.onmessage, al procesar mensajes de texto, ANTES del if (msg.event === "chunk") ──
// agregar:

if (msg.event === "use_cache") {
    // El servidor tiene el audio en caché → solo mandar parámetros, sin subir el archivo
    ws.send(JSON.stringify({ event: "params_only" }));
    return;
}

// ── Resultado esperado ────────────────────────────────────────────────────────
// Preview 1 (primer slider move después de subir el archivo):
//   Cliente envía: config JSON + archivo binario (igual que antes)
//   Servidor decodifica, recorta y guarda en AudioCache
//   Servidor responde: chunks de audio + métricas
//
// Preview 2..N (siguientes moves de slider, mismo archivo):
//   Cliente envía: config JSON (con session_id)
//   Servidor responde: {"event":"use_cache"}
//   Cliente responde: {"event":"params_only"}  ← sin bytes binarios
//   Servidor reutiliza el array numpy ya cacheado → procesa directo
//   Ahorro: 0 bytes de upload, 0 ms de decodificación de archivo
