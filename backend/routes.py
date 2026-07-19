from __future__ import annotations

import os
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

try:
    from .audio_service import AudioService
    from .job_service import JobService
    from .mastering import mix_advice
    from .validation_utils import validate_audio_file
    from .config import MAX_FILE_SIZE
except ImportError:  # pragma: no cover - fallback for direct script execution
    from audio_service import AudioService
    from job_service import JobService
    from mastering import mix_advice
    from validation_utils import validate_audio_file
    from config import MAX_FILE_SIZE

router = APIRouter()


def build_routes(job_service: JobService, audio_service: AudioService, upload_dir: str, app_state: dict):
    @router.post("/analyze", tags=["Análisis"])
    async def analyze(file: UploadFile = File(...)):
        validate_audio_file(file.filename)
        data = await file.read()
        if len(data) > MAX_FILE_SIZE:
            raise HTTPException(413, f"Archivo demasiado grande. Máximo: {MAX_FILE_SIZE // 1024 // 1024} MB")
        tmp = os.path.join(upload_dir, f"analyze_{uuid.uuid4().hex}")
        try:
            with open(tmp, "wb") as handle:
                handle.write(data)
            result = await app_state["run_in_threadpool"](audio_service.analyze_file, tmp)
            return result
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(500, str(exc)) from exc
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    @router.post("/mix-advice", tags=["Análisis"])
    async def get_mix_advice(file: UploadFile = File(...)):
        validate_audio_file(file.filename)
        data = await file.read()
        if len(data) > MAX_FILE_SIZE:
            raise HTTPException(413, f"Archivo demasiado grande. Máximo: {MAX_FILE_SIZE // 1024 // 1024} MB")
        tmp = os.path.join(upload_dir, f"advice_{uuid.uuid4().hex}")
        try:
            with open(tmp, "wb") as handle:
                handle.write(data)
            analysis = await app_state["run_in_threadpool"](audio_service.analyze_file, tmp)
            return {"analysis": analysis, **mix_advice(analysis)}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(500, str(exc)) from exc
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    @router.post("/spectrum", tags=["Análisis"])
    async def spectrum(file: UploadFile = File(...), n_fft: int = Query(4096, ge=256, le=16384), n_bins: int = Query(64, ge=8, le=256)):
        validate_audio_file(file.filename)
        data = await file.read()
        if len(data) > MAX_FILE_SIZE:
            raise HTTPException(413, f"Archivo demasiado grande. Máximo: {MAX_FILE_SIZE // 1024 // 1024} MB")
        tmp = os.path.join(upload_dir, f"spectrum_{uuid.uuid4().hex}")
        try:
            with open(tmp, "wb") as handle:
                handle.write(data)
            return await app_state["run_in_threadpool"](audio_service.spectrum_file, tmp, n_fft=n_fft, n_bins=n_bins)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(500, str(exc)) from exc
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    @router.get("/job/{job_id}", tags=["Jobs"])
    def get_job(job_id: str):
        if not job_service.exists(job_id):
            raise HTTPException(404, "Job no encontrado")
        job = job_service.get_job(job_id).copy()
        if job.get("type") == "stems" and job.get("status") == "done":
            job["stem_download_urls"] = {name: f"/stems/download/{job_id}/{name}" for name in job.get("available_stems", [])}
            job.pop("stem_paths", None)
            return job
        if job.get("status") == "done":
            job["download_url"] = f"/download/{job_id}"
            job["report_url"] = f"/report/{job_id}"
            job["analysis_before"] = job["result"]["analysis_before"]
            job["analysis_after"] = job["result"]["analysis_after"]
            job["mix_advice_before"] = job["result"]["mix_advice_before"]
            job["mix_advice_after"] = job["result"]["mix_advice_after"]
            job["recommendations_before"] = job["result"].get("recommendations_before")
            job["recommendations_after"] = job["result"].get("recommendations_after")
            job["chain_meters"] = job["result"].get("chain_meters", {})
            job["output_bit_depth"] = job["result"].get("output_bit_depth")
            if "reference_match" in job["result"]:
                job["reference_match"] = job["result"]["reference_match"]
                job["analysis_reference"] = job["result"]["analysis_reference"]
            del job["result"]
        return job

    @router.get("/download/{job_id}", tags=["Jobs"])
    def download(job_id: str, name: Optional[str] = Query(None, description="Nombre del tema para el archivo descargado")):
        if not job_service.exists(job_id):
            raise HTTPException(404, "Job no encontrado")
        job = job_service.get_job(job_id)
        if job["status"] != "done":
            raise HTTPException(400, f"Job no listo: {job['status']}")
        output_path = job["result"]["output_path"]
        if not os.path.exists(output_path):
            raise HTTPException(410, "Archivo expirado. Volvé a masterizar.")
        fmt = job["params"]["output_format"]
        mt = "audio/mpeg" if fmt == "mp3" else ("audio/flac" if fmt == "flac" else "audio/wav")
        track_name = app_state["sanitize_track_name"](name)
        return FileResponse(output_path, media_type=mt, filename=f"{track_name}.{fmt}")

    @router.get("/report/{job_id}", tags=["Jobs"])
    def export_report(job_id: str):
        if not job_service.exists(job_id):
            raise HTTPException(404, "Job no encontrado")
        job = job_service.get_job(job_id)
        if job["status"] != "done":
            raise HTTPException(400, f"Job no listo: {job['status']}")
        report = {
            "job_id": job_id,
            "filename": job["filename"],
            "created_at": job["created_at"],
            "finished_at": job.get("finished_at"),
            "params": job["params"],
            "analysis_before": job["result"]["analysis_before"],
            "analysis_after": job["result"]["analysis_after"],
            "mix_advice_before": job["result"]["mix_advice_before"],
            "mix_advice_after": job["result"]["mix_advice_after"],
            "recommendations_before": job["result"].get("recommendations_before"),
            "recommendations_after": job["result"].get("recommendations_after"),
            "chain_meters": job["result"].get("chain_meters", {}),
        }
        if "reference_match" in job["result"]:
            report["reference_match"] = job["result"]["reference_match"]
            report["analysis_reference"] = job["result"]["analysis_reference"]
        return JSONResponse(content=report, headers={"Content-Disposition": f'attachment; filename="mastering_report_{job_id[:8]}.json"'})

    @router.get("/jobs", tags=["Jobs"])
    def list_jobs():
        return [{"job_id": k, "status": v["status"], "filename": v["filename"], "created_at": v["created_at"]}
                for k, v in job_service.get_all().items()]

    return router
