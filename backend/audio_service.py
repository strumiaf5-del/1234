from __future__ import annotations

import os
from typing import Any, Dict, Tuple, Optional

import librosa
import numpy as np
import soundfile as sf

try:
    from .mastering import analyze_audio, mix_advice, spectrum_analysis_fft
except ImportError:  # pragma: no cover - fallback for direct script execution
    from mastering import analyze_audio, mix_advice, spectrum_analysis_fft


class AudioService:
    """Servicio de alto nivel para análisis y métricas del audio."""

    def __init__(self, upload_dir: str = "uploads"):
        self.upload_dir = upload_dir
        os.makedirs(self.upload_dir, exist_ok=True)

    def analyze_file(self, file_path: str) -> Dict[str, Any]:
        audio, sr = librosa.load(file_path, sr=None, mono=False)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        analysis = analyze_audio(audio, sr)
        analysis["mix_advice"] = mix_advice(analysis)
        return analysis

    def spectrum_file(self, file_path: str, n_fft: int = 4096, n_bins: int = 64) -> Dict[str, Any]:
        audio, sr = librosa.load(file_path, sr=None, mono=False)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        return spectrum_analysis_fft(audio, sr, n_fft=n_fft, n_bins=n_bins)

    def read_audio(self, file_path: str) -> Tuple[np.ndarray, int]:
        audio, sr = librosa.load(file_path, sr=None, mono=False)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        return audio, sr

    def get_duration(self, file_path: str) -> Optional[float]:
        try:
            info = sf.info(file_path)
            if info.samplerate:
                return round(info.frames / info.samplerate, 3)
        except Exception:
            return None
