from __future__ import annotations

import os
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

try:
    from .audio_service import AudioService
    from .job_service import JobService
    from .mastering import get_preset, get_platform_target, process_audio, process_audio_with_reference, measure_lufs_integrated
    from .stem_analysis import analyze_stems_full
    from .stem_separation import separate_stems
    from .streaming_engine import master_stream_to_pcm16
    from .system_monitor import get_system_stats
    from .validation_utils import validate_audio_file, coerce_ws_chain_params
    from .config import MAX_FILE_SIZE
    from .ai_assistant import decide_mastering
    from .mastering import MASTERING_PRESETS, PLATFORM_LOUDNESS_TARGETS, analyze_audio, mix_advice, spectrum_analysis_fft, _crop_preview
except ImportError:  # pragma: no cover - fallback for direct script execution
    from audio_service import AudioService
    from job_service import JobService
    from mastering import get_preset, get_platform_target, process_audio, process_audio_with_reference, measure_lufs_integrated
    from stem_analysis import analyze_stems_full
    from stem_separation import separate_stems
    from streaming_engine import master_stream_to_pcm16
    from system_monitor import get_system_stats
    from validation_utils import validate_audio_file, coerce_ws_chain_params
    from config import MAX_FILE_SIZE
    from ai_assistant import decide_mastering
    from mastering import MASTERING_PRESETS, PLATFORM_LOUDNESS_TARGETS, analyze_audio, mix_advice, spectrum_analysis_fft, _crop_preview
import librosa
import numpy as np
import soundfile as sf

router = APIRouter()


def build_mastering_router(job_service: JobService, audio_service: AudioService, upload_dir: str, processed_dir: str, stems_dir: str, app_state: dict):
    def sanitize_track_name(name: Optional[str], fallback: str = "mastered") -> str:
        if not name:
            return fallback
        name = name.strip()
        if not name:
            return fallback
        name = name.replace("/", "-").replace("\\", "-")
        name = "".join(ch for ch in name if ch.isprintable())
        safe = "".join(ch for ch in name if ch.isalnum() or ch in " ._-()[]áéíóúÁÉÍÓÚñÑüÜ")
        safe = safe.strip(" .")
        safe = safe[:120]
        return safe or fallback

    def _get_input_duration(input_path: str) -> Optional[float]:
        duration = audio_service.get_duration(input_path)
        return duration

    def cleanup_old() -> None:
        import shutil
        import time
        now = time.time()
        try:
            for fname in os.listdir(processed_dir):
                fpath = os.path.join(processed_dir, fname)
                if os.path.isfile(fpath) and (now - os.path.getmtime(fpath)) > 3600:
                    os.remove(fpath)
        except Exception:
            pass
        try:
            for dirname in os.listdir(stems_dir):
                dpath = os.path.join(stems_dir, dirname)
                if os.path.isdir(dpath) and (now - os.path.getmtime(dpath)) > 3600:
                    shutil.rmtree(dpath, ignore_errors=True)
        except Exception:
            pass

    def _make_progress_cb(job_id: str):
        def _cb(pct: int, stage: str):
            if not job_service.exists(job_id):
                return
            job_service.update_job(job_id, progress=pct, stage=stage)
        return _cb

    def run_mastering_job(job_id: str, input_path: str, params: dict):
        job_service.update_job(job_id, status="processing", started_at=os.path.getmtime(input_path), progress=0, stage="Iniciando procesamiento")
        try:
            cleanup_old()
            result = process_audio(input_path, progress_cb=_make_progress_cb(job_id), **params)
            job_service.update_job(job_id, status="done", result=result, finished_at=os.path.getmtime(input_path), progress=100, stage="Completado")
        except Exception as exc:
            job_service.update_job(job_id, status="error", error=str(exc))

    def run_reference_job(job_id: str, input_path: str, reference_path: str, params: dict):
        job_service.update_job(job_id, status="processing", started_at=os.path.getmtime(input_path), progress=0, stage="Iniciando procesamiento")
        try:
            cleanup_old()
            result = process_audio_with_reference(input_path, reference_path, progress_cb=_make_progress_cb(job_id), **params)
            job_service.update_job(job_id, status="done", result=result, finished_at=os.path.getmtime(input_path), progress=100, stage="Completado")
        except Exception as exc:
            job_service.update_job(job_id, status="error", error=str(exc))

    def run_stems_job(job_id: str, input_path: str):
        job_service.update_job(job_id, status="processing", started_at=os.path.getmtime(input_path), progress=0, stage="Iniciando separación")
        try:
            cleanup_old()
            audio, sr = librosa.load(input_path, sr=None, mono=False)
            if audio.ndim == 1:
                audio = audio[np.newaxis, :]
            stems = separate_stems(audio, sr, progress_cb=_make_progress_cb(job_id))
            job_service.update_job(job_id, stage="Analizando stems", progress=96)
            import concurrent.futures
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            future = pool.submit(analyze_stems_full, stems, sr, measure_lufs_integrated)
            analysis = future.result(timeout=180)
            pool.shutdown(wait=False)
            stem_dir = os.path.join(stems_dir, job_id)
            os.makedirs(stem_dir, exist_ok=True)
            stem_paths = {}
            for name, stem_audio in stems.items():
                out_path = os.path.join(stem_dir, f"{name}.wav")
                data_to_write = stem_audio.T if stem_audio.ndim == 2 else stem_audio
                sf.write(out_path, data_to_write, sr, subtype="PCM_24")
                stem_paths[name] = out_path
            job_service.update_job(job_id, status="done", finished_at=os.path.getmtime(input_path), progress=100, stage="Completado", stem_analysis=analysis, stem_paths=stem_paths, available_stems=list(stem_paths.keys()))
        except Exception as exc:
            job_service.update_job(job_id, status="error", error=str(exc))
        finally:
            if os.path.exists(input_path):
                os.remove(input_path)

    @router.post("/master", tags=["Mastering"])
    async def master(file: UploadFile = File(...), background_tasks: BackgroundTasks = None, output_format: str = Query("wav", pattern="^(wav|flac|mp3)$"), output_bit_depth: int = Query(24)):
        validate_audio_file(file.filename)
        data = await file.read()
        if len(data) > MAX_FILE_SIZE:
            raise HTTPException(413, f"Archivo demasiado grande. Máximo: {MAX_FILE_SIZE // 1024 // 1024} MB")
        job_id = uuid.uuid4().hex
        input_path = os.path.join(upload_dir, f"{job_id}_{file.filename}")
        with open(input_path, "wb") as handle:
            handle.write(data)
        params = {"output_format": output_format, "output_bit_depth": output_bit_depth}
        job_service.create_job(job_id, {"status": "queued", "filename": file.filename, "created_at": os.path.getmtime(input_path), "params": params, "progress": 0, "stage": "En cola"})
        background_tasks.add_task(run_mastering_job, job_id, input_path, params)
        return {"job_id": job_id, "status": "queued", "poll_url": f"/job/{job_id}"}

    @router.post("/master/reference", tags=["Mastering"])
    async def master_reference(file: UploadFile = File(...), reference: UploadFile = File(...), background_tasks: BackgroundTasks = None, output_format: str = Query("wav", pattern="^(wav|flac|mp3)$"), output_bit_depth: int = Query(24)):
        validate_audio_file(file.filename)
        validate_audio_file(reference.filename)
        data_in = await file.read()
        data_ref = await reference.read()
        if len(data_in) > MAX_FILE_SIZE or len(data_ref) > MAX_FILE_SIZE:
            raise HTTPException(413, f"Archivo demasiado grande. Máximo: {MAX_FILE_SIZE // 1024 // 1024} MB")
        job_id = uuid.uuid4().hex
        input_path = os.path.join(upload_dir, f"{job_id}_in_{file.filename}")
        ref_path = os.path.join(upload_dir, f"{job_id}_ref_{reference.filename}")
        with open(input_path, "wb") as handle:
            handle.write(data_in)
        with open(ref_path, "wb") as handle:
            handle.write(data_ref)
        params = {"output_format": output_format, "output_bit_depth": output_bit_depth}
        job_service.create_job(job_id, {"status": "queued", "filename": file.filename, "created_at": os.path.getmtime(input_path), "params": params, "progress": 0, "stage": "En cola"})
        background_tasks.add_task(run_reference_job, job_id, input_path, ref_path, params)
        return {"job_id": job_id, "status": "queued", "poll_url": f"/job/{job_id}"}

    @router.post("/stems/separate", tags=["Stems"])
    async def stems_separate(file: UploadFile = File(...), background_tasks: BackgroundTasks = None):
        validate_audio_file(file.filename)
        data = await file.read()
        if len(data) > MAX_FILE_SIZE:
            raise HTTPException(413, f"Archivo demasiado grande. Máximo: {MAX_FILE_SIZE // 1024 // 1024} MB")
        job_id = uuid.uuid4().hex
        input_path = os.path.join(upload_dir, f"{job_id}_{file.filename}")
        with open(input_path, "wb") as handle:
            handle.write(data)
        job_service.create_job(job_id, {"status": "queued", "type": "stems", "filename": file.filename, "created_at": os.path.getmtime(input_path), "params": {}, "progress": 0, "stage": "En cola"})
        background_tasks.add_task(run_stems_job, job_id, input_path)
        return {"job_id": job_id, "status": "queued", "poll_url": f"/job/{job_id}"}

    @router.get("/stems/download/{job_id}/{stem_name}", tags=["Stems"])
    def stems_download(job_id: str, stem_name: str):
        if not job_service.exists(job_id):
            raise HTTPException(404, "Job no encontrado")
        job = job_service.get_job(job_id)
        if job.get("type") != "stems" or job.get("status") != "done":
            raise HTTPException(400, f"Job no listo: {job.get('status')}")
        stem_path = job.get("stem_paths", {}).get(stem_name)
        if not stem_path or not os.path.exists(stem_path):
            raise HTTPException(410, "Stem no encontrado o expirado. Volvé a separar el track.")
        return FileResponse(stem_path, media_type="audio/wav", filename=f"{stem_name}.wav")

    return router
