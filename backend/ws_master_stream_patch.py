"""
Parche para /ws/master-stream en app.py.

REEMPLAZAR el handler existente @app.websocket("/ws/master-stream") completo
con este bloque.  También agregar al inicio de app.py:

    from audio_cache import put as audio_cache_put, get as audio_cache_get

PROTOCOLO CLIENTE → SERVIDOR (hacia atrás compatible):

  Mensaje 1 (JSON, siempre):
    {
      "session_id": "<uuid-del-archivo-actual>",   # nuevo campo
      "chunk_seconds": 0.35,
      "preview_seconds": 10,
      ...params de cadena...
    }

  Si session_id NO está en caché del servidor:
    → cliente envía frames binarios del archivo + {"event":"upload_complete"}
      (igual que antes)

  Si session_id YA está en caché:
    → servidor responde {"event":"use_cache"} y espera que el cliente envíe
      {"event":"params_only"} (sin binarios).
      El cliente puede seguir enviando binarios si ignora use_cache —
      el servidor los acepta igual (retrocompatible).

CAMBIOS EN index.html (en runLivePreview):

  1. Generar session_id al cargar el archivo (una vez):
       let _previewSessionId = null;
       function setFile(f) {
         _previewSessionId = crypto.randomUUID();
         ...
       }

  2. En ws.onopen, incluir session_id en el JSON de config:
       cfg.session_id = _previewSessionId;

  3. Al recibir {"event":"use_cache"}, saltar el upload:
       if (msg.event === "use_cache") {
         ws.send(JSON.stringify({ event: "params_only" }));
         return;   // no enviar binarios
       }
"""

import json
import os
import uuid

import librosa
import numpy as np
from fastapi import WebSocket, WebSocketDisconnect

# Importar desde audio_cache.py (debe estar junto a app.py)
try:
    from .audio_cache import get as audio_cache_get, put as audio_cache_put
except ImportError:
    from audio_cache import get as audio_cache_get, put as audio_cache_put

# ── Handler ──────────────────────────────────────────────────────────────────────

async def ws_master_stream_handler(
    websocket: WebSocket,
    UPLOAD_DIR: str,
    MAX_FILE_SIZE: int,
    get_preset_fn,          # mastering.get_preset
    get_platform_target_fn, # mastering.get_platform_target
    crop_preview_fn,        # mastering._crop_preview
    stream_fn,              # streaming_engine.master_stream_to_pcm16
    coerce_fn,              # validation_utils.coerce_ws_chain_params
    run_in_threadpool,      # fastapi.concurrency.run_in_threadpool
    logger,
):
    await websocket.accept()
    tmp_path = None
    try:
        # ── 1. Config JSON ───────────────────────────────────────────────────────
        config_msg = await websocket.receive_json()
        chunk_seconds   = float(config_msg.get("chunk_seconds", 2.0))
        preset_name     = config_msg.get("preset")
        platform        = config_msg.get("platform_target")
        preview_seconds = config_msg.get("preview_seconds")
        session_id      = config_msg.get("session_id")          # puede ser None

        chain_params = {
            k: v for k, v in config_msg.items()
            if k not in ("chunk_seconds", "preset", "platform_target",
                         "preview_seconds", "type", "session_id")
        }
        if preset_name:
            chain_params = {**get_preset_fn(preset_name), **chain_params}
            chain_params.pop("label", None)
        if platform:
            chain_params["use_lufs_normalize"] = True
            chain_params["target_lufs"] = get_platform_target_fn(platform)["lufs"]
        chain_params = coerce_fn(chain_params)

        # ── 2. Audio: caché o upload ─────────────────────────────────────────────
        audio = sr = None

        if session_id:
            cached = audio_cache_get(session_id)
            if cached is not None:
                audio, sr = cached
                # Avisamos al cliente que puede omitir el upload
                await websocket.send_json({"event": "use_cache"})

        if audio is None:
            # Necesitamos recibir el archivo
            audio_chunks = []
            total_size   = 0
            while True:
                message = await websocket.receive()
                if message.get("bytes") is not None:
                    chunk = message["bytes"]
                    total_size += len(chunk)
                    if total_size > MAX_FILE_SIZE:
                        await websocket.send_json({
                            "event": "error",
                            "message": f"Archivo demasiado grande. "
                                       f"Máximo: {MAX_FILE_SIZE // 1024 // 1024} MB",
                        })
                        return
                    audio_chunks.append(chunk)
                elif message.get("text") is not None:
                    try:
                        ctrl = json.loads(message["text"])
                    except Exception:
                        ctrl = {}
                    event = ctrl.get("event")
                    if event in ("upload_complete", "params_only"):
                        break
                elif message.get("type") == "websocket.disconnect":
                    return
                else:
                    break

            audio_bytes = b"".join(audio_chunks)
            if not audio_bytes:
                await websocket.send_json({"event": "error", "message": "No se recibió audio."})
                return

            tmp_path = os.path.join(UPLOAD_DIR, f"stream_{uuid.uuid4().hex}")
            with open(tmp_path, "wb") as fh:
                fh.write(audio_bytes)

            audio, sr = await run_in_threadpool(librosa.load, tmp_path, sr=None, mono=False)
            if audio.ndim == 1:
                audio = audio[np.newaxis, :]

            # Guardar en caché para los próximos previews de esta sesión
            if session_id:
                # El recorte de preview se hace ANTES de cachear para que
                # todos los previews sean del mismo extracto.
                preview_window = float(preview_seconds) if preview_seconds else 10.0
                audio = crop_preview_fn(audio, sr, preview_window)
                audio_cache_put(session_id, audio, sr)
            else:
                preview_window = float(preview_seconds) if preview_seconds else 10.0
                audio = crop_preview_fn(audio, sr, preview_window)
        else:
            # Ya tenía el audio recortado en caché; ignoramos preview_seconds
            # porque el recorte ya se hizo al subir por primera vez.
            # Igual drenamos cualquier frame que el cliente haya mandado
            # antes de recibir el "use_cache" (race condition).
            pass

        chain_params.pop("output_format", None)
        chain_params.pop("preview_seconds", None)

        # ── 3. Streaming ─────────────────────────────────────────────────────────
        chunk_gen = stream_fn(audio, sr, chunk_seconds=chunk_seconds, **chain_params)
        _SENTINEL = object()
        while True:
            item = await run_in_threadpool(next, chunk_gen, _SENTINEL)
            if item is _SENTINEL:
                break
            pcm_bytes, metrics = item
            await websocket.send_json({
                "event": "chunk",
                "metrics": metrics,
                "sample_rate": sr,
                "channels": int(audio.shape[0]),
            })
            await websocket.send_bytes(pcm_bytes)

        await websocket.send_json({"event": "done"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"ws_master_stream error: {e}", exc_info=True)
        try:
            await websocket.send_json({"event": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
