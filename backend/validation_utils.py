import os
from typing import Optional

from fastapi import HTTPException

ALLOWED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".aiff", ".aif"}
MAX_FILE_SIZE = 200 * 1024 * 1024

_BOOL_QUERY_KEYS = {
    "use_lufs_normalize", "comp_stereo_link", "mb_bypass", "mb_stereo_bypass",
    "use_stereo_enhancer", "glue_bypass",
    # BUGFIX: faltaban estas — sin estar en el set, coerce_ws_chain_params()
    # dejaba pasar el string literal "false" (truthy en Python) en vez de
    # convertirlo a bool, así que dynamic_eq_band() siempre veía bypass=True
    # sin importar el checkbox. Esto rompía los meters de GR de de-esser y
    # resonancias dinámicas (y potencialmente lp/ms_eq/clipper/nr) solo en
    # el preview en vivo por WebSocket — el render final vía /master no se
    # veía afectado porque ahí FastAPI parsea los Query(bool) correctamente.
    "dyneq_bypass", "reso_bypass", "lp_bypass", "ms_eq_bypass", "ms_comp_bypass",
    "clipper_bypass", "nr_bypass",
    "parallel_bypass",   # BUGFIX: faltaba — sin esto, el string "false" llegaba truthy por WS
}


def validate_audio_file(filename: str) -> None:
    if not filename or not isinstance(filename, str):
        raise HTTPException(400, "Nombre de archivo inválido o faltante.")
    ext = os.path.splitext(filename)[-1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Formato '{ext}' no soportado. Válidos: {sorted(ALLOWED_EXTENSIONS)}")


def coerce_ws_chain_params(params: dict) -> dict:
    """Convierte params recibidos por WebSocket desde URLSearchParams/JSON."""
    out = {}
    for key, value in params.items():
        if key in _BOOL_QUERY_KEYS:
            if isinstance(value, str):
                out[key] = value.strip().lower() in {"1", "true", "yes", "on", "sí", "si"}
            else:
                out[key] = bool(value)
            continue
        if isinstance(value, str):
            value = value.strip()
            if value == "":
                continue
            try:
                out[key] = float(value)
                continue
            except ValueError:
                pass
        out[key] = value
    return out


def read_and_validate_upload(file, max_file_size: int = MAX_FILE_SIZE) -> bytes:
    data = file.read()
    if len(data) > max_file_size:
        raise HTTPException(413, f"Archivo demasiado grande. Máximo: {max_file_size // 1024 // 1024} MB")
    return data
