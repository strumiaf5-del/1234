"""
Librería persistente de archivos de audio originales.

Problema que resuelve:
  UPLOAD_DIR es efímero: cada archivo se guarda con un nombre {job_id}_{filename}
  y en general se borra (o queda huérfano) al terminar el job. Para volver a
  masterizar/previsualizar el mismo tema, había que volver a subirlo desde
  cero cada vez.

Solución:
  Al guardar un archivo en la librería, se copia a LIBRARY_DIR con un nombre
  único (uuid) y se registra su metadata (nombre original, duración, sr,
  canales, tamaño, fecha de subida) en un índice JSON. NO tiene TTL — vive
  hasta que el usuario lo borra explícitamente desde la web. El frontend
  puede listar la librería (GET /library) y usar un archivo por su id, sin
  necesidad de volver a seleccionarlo del disco local.

Formato del índice ({LIBRARY_DIR}/_index.json):
  { file_id: {id, original_filename, stored_filename, size_bytes,
              duration_sec, sample_rate, channels, uploaded_at} }
"""
import os
import json
import time
import uuid
import shutil
import threading
from typing import Optional

try:
    import soundfile as sf
except ImportError:  # pragma: no cover
    sf = None

_lock = threading.Lock()


def _index_path(library_dir: str) -> str:
    return os.path.join(library_dir, "_index.json")


def _load_index(library_dir: str) -> dict:
    """Sin lock — el caller ya lo tiene tomado."""
    path = _index_path(library_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        # Índice corrupto (ej. proceso murió a mitad de escritura antes del
        # os.replace atómico de abajo, o edición manual rota) -> arrancar de
        # cero antes que tirar 500 en cada request. Los archivos en disco no
        # se tocan, solo se pierde su entrada del índice.
        return {}


def _save_index(library_dir: str, index: dict) -> None:
    """Escritura atómica (tmp + os.replace) para que un crash a mitad de
    escritura nunca deje el índice corrupto/truncado."""
    path = _index_path(library_dir)
    tmp = path + f".tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _probe_audio(path: str) -> dict:
    """Duración/sr/canales leyendo solo el header (soundfile.info), sin
    decodificar el audio completo — instantáneo incluso con archivos de
    varios cientos de MB."""
    if sf is not None:
        try:
            info = sf.info(path)
            return {
                "duration_sec": round(float(info.frames) / float(info.samplerate), 2),
                "sample_rate": int(info.samplerate),
                "channels": int(info.channels),
            }
        except Exception:
            pass
    return {"duration_sec": None, "sample_rate": None, "channels": None}


def add_file(library_dir: str, original_filename: str, data: bytes) -> dict:
    """Guarda `data` como un nuevo archivo de la librería y devuelve su metadata."""
    os.makedirs(library_dir, exist_ok=True)
    file_id = uuid.uuid4().hex
    ext = os.path.splitext(original_filename)[1].lower() or ".wav"
    stored_name = f"{file_id}{ext}"
    stored_path = os.path.join(library_dir, stored_name)
    with open(stored_path, "wb") as f:
        f.write(data)

    meta = {
        "id": file_id,
        "original_filename": original_filename,
        "stored_filename": stored_name,
        "size_bytes": len(data),
        "uploaded_at": time.time(),
        **_probe_audio(stored_path),
    }
    with _lock:
        index = _load_index(library_dir)
        index[file_id] = meta
        _save_index(library_dir, index)
    return meta


def list_files(library_dir: str) -> list:
    """Más reciente primero."""
    with _lock:
        index = _load_index(library_dir)
    return sorted(index.values(), key=lambda m: m.get("uploaded_at", 0), reverse=True)


def get_meta(library_dir: str, file_id: str) -> Optional[dict]:
    with _lock:
        index = _load_index(library_dir)
    return index.get(file_id)


def get_path(library_dir: str, file_id: str) -> Optional[str]:
    """Devuelve la ruta en disco del archivo, o None si no existe (id inválido
    o el archivo fue borrado del disco por fuera de este módulo)."""
    meta = get_meta(library_dir, file_id)
    if meta is None:
        return None
    path = os.path.join(library_dir, meta["stored_filename"])
    return path if os.path.exists(path) else None


def delete_file(library_dir: str, file_id: str) -> bool:
    with _lock:
        index = _load_index(library_dir)
        meta = index.pop(file_id, None)
        if meta is None:
            return False
        _save_index(library_dir, index)
    stored_path = os.path.join(library_dir, meta["stored_filename"])
    try:
        if os.path.exists(stored_path):
            os.remove(stored_path)
    except Exception:
        pass
    return True
