"""
Caché de audio en memoria para el preview WebSocket.

Problema que resuelve:
  En cada cambio de slider, el frontend re-enviaba el archivo de audio completo
  al backend (hasta 200 MB) antes de que el servidor pudiera procesar los nuevos
  parámetros. Esto causaba:
  - Latencia de red innecesaria (100-500 ms por preview en LAN, segundos en WAN)
  - Picos de CPU por re-decodificar el mismo archivo cada vez
  - Picos de RAM al tener N uploads simultáneos del mismo archivo

Solución:
  El cliente genera un session_id (UUID) cuando carga un archivo. Al primer
  preview envía el archivo completo + session_id. En los siguientes previews
  del mismo archivo solo envía session_id + parámetros, y el backend reutiliza
  el array numpy ya decodificado y recortado del caché.

  El caché es LRU con TTL: entradas que no se usaron en MAX_AGE_SEC se
  expiran automáticamente (lazy, en cada acceso y periódicamente). Tiene
  un límite de MAX_ENTRIES entradas para no crecer sin límite.
"""
import threading
import time
from typing import Optional, Tuple
import numpy as np

MAX_ENTRIES = 20          # máx. sesiones simultáneas cacheadas
MAX_AGE_SEC = 600.0       # 10 minutos de inactividad → evicción

_lock = threading.Lock()
# { session_id: {"audio": np.ndarray, "sr": int, "last_access": float} }
_cache: dict = {}


def _evict_expired() -> None:
    """Elimina entradas viejas (llamado sin el lock — el caller lo adquiere)."""
    now = time.monotonic()
    expired = [k for k, v in _cache.items() if now - v["last_access"] > MAX_AGE_SEC]
    for k in expired:
        del _cache[k]


def put(session_id: str, audio: np.ndarray, sr: int) -> None:
    """Almacena (o actualiza) el audio de una sesión."""
    with _lock:
        _evict_expired()
        # Si ya llegamos al límite, sacar el más antiguo (LRU simplificado)
        if len(_cache) >= MAX_ENTRIES and session_id not in _cache:
            oldest = min(_cache, key=lambda k: _cache[k]["last_access"])
            del _cache[oldest]
        _cache[session_id] = {
            "audio": audio,
            "sr": sr,
            "last_access": time.monotonic(),
        }


def get(session_id: str) -> Optional[Tuple[np.ndarray, int]]:
    """Devuelve (audio, sr) si el session_id existe y no expiró, o None."""
    with _lock:
        entry = _cache.get(session_id)
        if entry is None:
            return None
        if time.monotonic() - entry["last_access"] > MAX_AGE_SEC:
            del _cache[session_id]
            return None
        entry["last_access"] = time.monotonic()
        return entry["audio"], entry["sr"]


def evict(session_id: str) -> None:
    """Elimina manualmente una sesión (ej. cuando el cliente sube un archivo nuevo)."""
    with _lock:
        _cache.pop(session_id, None)


def stats() -> dict:
    """Para el dashboard: cuántas sesiones hay en caché y cuánta RAM usan aprox."""
    with _lock:
        n = len(_cache)
        mb = sum(
            v["audio"].nbytes for v in _cache.values()
            if isinstance(v.get("audio"), np.ndarray)
        ) / 1024 / 1024
    return {"cached_sessions": n, "estimated_mb": round(mb, 1)}
