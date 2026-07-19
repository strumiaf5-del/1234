from __future__ import annotations

import asyncio
import os
import time
from typing import Optional, List

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

try:
    from .ai_assistant import get_unavailable_reason, is_available, AI_MODEL, chat as ai_chat
    from .job_service import JobService
    from .system_monitor import get_system_stats
except ImportError:  # pragma: no cover - fallback for direct script execution
    from ai_assistant import get_unavailable_reason, is_available, AI_MODEL, chat as ai_chat
    from job_service import JobService
    from system_monitor import get_system_stats

router = APIRouter()


class AiChatMessage(BaseModel):
    role: str
    content: str


class AiChatRequest(BaseModel):
    message: str
    history: List[AiChatMessage] = Field(default_factory=list)
    analysis: Optional[dict] = None
    preset: Optional[str] = None
    platform: Optional[str] = None


def build_ai_router(job_service: JobService, app_state: dict):
    @router.get("/ai/status", tags=["Asistente IA"])
    async def ai_status():
        available = is_available()
        return {
            "available": available,
            "model": AI_MODEL if available else None,
            "reason": None if available else get_unavailable_reason(),
        }

    @router.post("/ai/chat", tags=["Asistente IA"])
    async def ai_chat_endpoint(req: AiChatRequest):
        if not req.message or not req.message.strip():
            raise HTTPException(400, "El mensaje no puede estar vacío.")
        try:
            result = await app_state["run_in_threadpool"](
                ai_chat,
                req.message,
                [(m.model_dump() if hasattr(m, "model_dump") else m.dict()) for m in req.history],
                req.analysis,
                req.preset,
                req.platform,
            )
            return result
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(500, "Error interno del asistente de IA.") from exc

    @router.get("/dashboard", tags=["Dashboard"])
    def dashboard():
        return get_system_stats(job_service.get_all())

    @router.websocket("/ws/dashboard")
    async def ws_dashboard(websocket: WebSocket):
        await websocket.accept()
        try:
            while True:
                await websocket.send_json(get_system_stats(job_service.get_all()))
                await asyncio.sleep(1.0)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    return router
