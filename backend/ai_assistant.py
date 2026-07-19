#ai_assistant.py — Asistente de IA conversacional para mastering (estilo LANDR AI).



from __future__ import annotations

import os
import json
import logging
import re
from typing import Optional, Dict, Tuple

import requests

logger = logging.getLogger(__name__)

# Carga opcional de un archivo .env (backend/.env) si python-dotenv está instalado.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Acepta GEMINI_API_KEY o GOOGLE_API_KEY (los mismos nombres que usan los SDKs oficiales).
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
AI_MODEL = os.environ.get("AI_ASSISTANT_MODEL", "gemini-2.5-flash")
MAX_HISTORY_MESSAGES = 20  # últimos N mensajes de la conversación que se reenvían

# Se habla directo con la API REST de Gemini (sin SDK oficial): tanto
# google-genai como google-generativeai piden Python >=3.9 y no instalan en
# Windows 7 / Python 3.8. `requests` no tiene ese piso ni dependencias con
# Rust, así que evita también el problema de "cryptography" con Windows 7.
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"

_client = None
_client_error: Optional[str] = None


def _get_client():
    """Valida (de forma perezosa) que haya una API key configurada y cachea el
    resultado. Ya no instancia ningún SDK: las llamadas van por REST directo,
    ver `_gemini_generate_content`."""
    global _client, _client_error
    if _client is not None:
        return _client
    if _client_error is not None:
        return None
    if not GEMINI_API_KEY:
        _client_error = (
            "Falta configurar la variable de entorno GEMINI_API_KEY en el backend."
        )
        logger.warning(_client_error)
        return None
    _client = True
    return _client


def is_available() -> bool:
    return _get_client() is not None


def _gemini_generate_content(system_prompt: str, contents: list,
                              max_output_tokens: int = 2048,
                              thinking_budget: Optional[int] = None,
                              temperature: Optional[float] = None) -> Optional[str]:
    """Llama directo al endpoint REST generateContent de Gemini (sin SDK) y \
    devuelve el texto crudo de la respuesta. `contents` ya viene armado en el \
    formato de la API: [{"role": "user"|"model", "parts": [{"text": ...}]}, ...]. \
    Siempre se pide responseMimeType=application/json, así que el texto devuelto \
    debería ser JSON parseable (ver `_extract_json_object`). Devuelve None si la \
    llamada falla, no hay candidatos (p.ej. bloqueo de safety) o hay error de red."""
    url = f"{GEMINI_API_BASE}/models/{AI_MODEL}:generateContent"
    generation_config = {
        "responseMimeType": "application/json",
        "maxOutputTokens": max_output_tokens,
    }
    if thinking_budget is not None:
        generation_config["thinkingConfig"] = {"thinkingBudget": thinking_budget}
    if temperature is not None:
        generation_config["temperature"] = temperature
    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": generation_config,
    }
    try:
        resp = requests.post(url, params={"key": GEMINI_API_KEY}, json=payload, timeout=45)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error(f"Error llamando a la API REST de Gemini: {e}")
        return None

    candidates = data.get("candidates") or []
    if not candidates:
        feedback = data.get("promptFeedback")
        logger.warning(f"Gemini no devolvió candidatos (posible bloqueo de safety). promptFeedback={feedback}")
        return None
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if "text" in p)
    finish_reason = candidates[0].get("finishReason")
    if not text:
        logger.warning(f"Gemini devolvió una respuesta sin texto (finishReason={finish_reason}).")
        return None
    if finish_reason == "MAX_TOKENS":
        # La respuesta se cortó antes de terminar (típico cuando thinking_budget
        # dinámico/alto se come la mayor parte de maxOutputTokens, que en la API
        # de Gemini es un presupuesto COMPARTIDO entre tokens de pensamiento y
        # texto de salida). El texto parcial casi siempre es JSON inválido —
        # se loguea acá para que quede claro en el log en vez de solo verse
        # como "JSON ilegible" río abajo, sin pista de la causa real.
        logger.warning(
            f"Gemini cortó la respuesta por MAX_TOKENS (maxOutputTokens insuficiente "
            f"para thinking + salida). Texto parcial: {len(text)} chars."
        )
    return text




def get_unavailable_reason() -> str:
    return _client_error or "El asistente de IA no está disponible."


def _fmt(v, unit: str = "", nd: int = 2) -> str:
    if v is None:
        return "sin datos"
    try:
        return f"{round(float(v), nd)}{unit}"
    except (TypeError, ValueError):
        return str(v)


def build_audio_context(analysis: Optional[dict], preset: Optional[str] = None,
                         platform: Optional[str] = None) -> str:
    """Convierte el dict de analyze_audio()/mix_advice() en texto legible para el modelo."""
    if not analysis:
        return "El usuario todavía no subió ningún audio ni corrió un análisis en esta sesión."

    lines = ["Datos técnicos del análisis del track actual del usuario (decenas de métricas ya calculadas):"]

    lines.append("· Loudness / nivel:")
    lines.append(f"    - LUFS integrado: {_fmt(analysis.get('lufs'), ' LUFS')}")
    lines.append(f"    - Pico (sample): {_fmt(analysis.get('peak_db'), ' dBFS')}")
    lines.append(f"    - True peak (inter-sample, 4x oversample): {_fmt(analysis.get('true_peak_db'), ' dBTP')}")
    lines.append(f"    - RMS: {_fmt(analysis.get('rms_db'), ' dBFS')}")
    lines.append(f"    - PLR (true peak - LUFS): {_fmt(analysis.get('plr_db'), ' dB')}")
    st = analysis.get("loudness_short_term") or {}
    if st:
        lines.append(f"    - Loudness de corto plazo (ventanas 3s): máx {_fmt(st.get('max'), ' LUFS')}, "
                      f"mín {_fmt(st.get('min'), ' LUFS')}, p95 {_fmt(st.get('p95'), ' LUFS')}")
    lines.append(f"    - LRA (rango de loudness): {_fmt(analysis.get('lra'), ' LU')}")

    lines.append("· Dinámica:")
    lines.append(f"    - Rango dinámico global (crest factor): {_fmt(analysis.get('dynamic_range_db'), ' dB')}")
    band_dyn = analysis.get("band_dynamics_db") or {}
    if band_dyn:
        lines.append(f"    - Crest factor por banda: graves {_fmt(band_dyn.get('low'), ' dB')}, "
                      f"medios {_fmt(band_dyn.get('mid'), ' dB')}, agudos {_fmt(band_dyn.get('high'), ' dB')}")

    lines.append("· Higiene de señal:")
    lines.append(f"    - DC offset: {_fmt(analysis.get('dc_offset'), '', 5)}")
    lines.append(f"    - Clipping real: {_fmt((analysis.get('clipping_ratio') or 0) * 100, '% de las muestras', 3)}")
    lines.append(f"    - Silencio (<-60dB): {_fmt((analysis.get('silence_ratio') or 0) * 100, '% del track', 2)}")

    lines.append("· Estéreo:")
    lines.append(f"    - Correlación L/R global: {_fmt(analysis.get('stereo_correlation'), '', 3)}")
    band_st = analysis.get("band_stereo_correlation") or {}
    if band_st:
        lines.append(f"    - Correlación L/R por banda: graves {_fmt(band_st.get('low'), '', 3)}, "
                      f"medios {_fmt(band_st.get('mid'), '', 3)}, agudos {_fmt(band_st.get('high'), '', 3)}")
    lines.append(f"    - Compatibilidad mono (pérdida al sumar L+R): {_fmt(analysis.get('mono_compatibility_db'), ' dB')}")

    lines.append("· Timbre / forma espectral:")
    lines.append(f"    - Centroid espectral: {_fmt(analysis.get('spectral_centroid_hz'), ' Hz', 0)}")
    lines.append(f"    - Rolloff (85% energía): {_fmt(analysis.get('spectral_rolloff_hz'), ' Hz', 0)}")
    lines.append(f"    - Flatness espectral (0=tonal, 1=ruidoso): {_fmt(analysis.get('spectral_flatness'), '', 4)}")
    lines.append(f"    - Zero-crossing rate: {_fmt(analysis.get('zero_crossing_rate'), '', 4)}")

    lines.append("· Ritmo:")
    lines.append(f"    - Densidad de transientes: {_fmt(analysis.get('transient_density'), ' onsets/seg', 2)}")

    spectrum = analysis.get("spectrum") or {}
    if spectrum:
        band_names = {
            "sub_bass": "Sub-bajos (20-80Hz)", "bass": "Bajos (80-250Hz)",
            "low_mid": "Medios-bajos (250-500Hz)", "mid": "Medios (500-2kHz)",
            "upper_mid": "Medios-altos (2-4kHz)", "presence": "Presencia (4-8kHz)",
            "air": "Aire (8-20kHz)",
        }
        lines.append("· Balance espectral (energía relativa en dB por banda):")
        for key, label in band_names.items():
            if key in spectrum:
                lines.append(f"    · {label}: {_fmt(spectrum[key], ' dB')}")

    advice = analysis.get("mix_advice")
    if isinstance(advice, dict):
        issues = advice.get("issues") or []
        tips = advice.get("tips") or []
        score = advice.get("score")
        if score is not None:
            lines.append(f"- Score de calidad del motor de reglas interno: {score}/100")
        if issues:
            lines.append("- Problemas detectados automáticamente:")
            for i in issues:
                lines.append(f"    · {i}")
        if tips:
            lines.append("- Sugerencias automáticas del motor de reglas:")
            for t in tips:
                lines.append(f"    · {t}")

    if preset:
        lines.append(f"- Preset de mastering seleccionado por el usuario: {preset}")
    if platform:
        lines.append(f"- Plataforma/target de loudness elegido: {platform}")

    return "\n".join(lines)


SYSTEM_PROMPT_TEMPLATE = """Sos el Asistente de IA de MASTER, un estudio de mastering de audio online \
(similar en espíritu al asistente de IA de LANDR). Hablás en español rioplatense, con tono \
cercano, profesional y directo, como un ingeniero de mastering con experiencia que está \
mirando la sesión del usuario en tiempo real.

Tenés acceso al análisis técnico real del track que subió el usuario (ver más abajo). \
Usalo SIEMPRE que sea relevante para dar respuestas específicas y accionables, citando los \
números concretos (LUFS, dB, balance espectral, etc.) en vez de consejos genéricos.

Además de responder en texto, PODÉS proponer un cambio concreto y aplicable a la cadena de \
mastering (igual que el asistente de LANDR, que no solo aconseja sino que ajusta el master). \
Para eso completá los campos numéricos/booleanos de parámetros que quieras cambiar; dejá en \
null (sin completar) todos los que no correspondan.

Cuándo SÍ proponer parámetros:
- El usuario pide explícitamente un cambio o efecto ("más brillo", "que suene más fuerte", \
"bajale la compresión", "quiero más pegada en el bajo", "subilo a -9 LUFS para Spotify", etc.).
- Vos mismo detectás en el análisis un problema puntual y accionable y el usuario te pidió consejo \
sobre eso (no lo hagas de prepo en preguntas puramente teóricas).

Cuándo NO proponer parámetros (dejar todo en null):
- Preguntas generales de teoría, flujo de trabajo, o que no dependen del track.
- No hay análisis disponible todavía.
- El usuario está charlando, agradeciendo, o pidiendo una aclaración sin pedir un ajuste.

Reglas para las propuestas:
- Cambiá SOLO los parámetros relevantes al pedido puntual (normalmente 1 a 6 campos), NUNCA \
completes todos los campos del esquema como si fuera un mastering completo desde cero.
- Los campos de umbral y techo (comp_threshold_db, mb_low/mid/high_threshold_db, target_peak_db, \
limiter_ceiling_db) están SIEMPRE en dB relativos a 0dBFS (0 = techo digital, valores negativos \
hacia abajo), igual que cualquier otro parámetro en dB de esta lista. No hay ningún parámetro \
en escala lineal 0-1 en este esquema — todo lo que es amplitud/nivel se expresa en dB.
- Los valores deben estar dentro de los rangos válidos (ver más abajo) y ser coherentes con el \
análisis real del track, no genéricos.
- Si proponés parámetros, completá también "suggestion_summary" con una frase muy corta (5-9 \
palabras) que resuma el cambio, ej: "Más aire arriba de 8kHz" o "Bajar 2dB el makeup del compresor".
- En "reply" explicá en 1-3 oraciones qué le vas a cambiar y por qué, en tono conversacional \
(el usuario va a ver un botón aparte para aplicar los valores, no hace falta que listes cada \
número ahí).

Lineamientos generales:
- Sé conciso: respuestas cortas (2-6 oraciones o una lista breve), esto es un chat, no un ensayo.
- Si el usuario pregunta algo que no depende del análisis (teoría, flujo de trabajo, qué preset \
usar, cómo usar la herramienta), respondé igual con tu conocimiento de mastering/mezcla.
- Si no hay análisis disponible todavía, decilo y sugerí analizar o subir un audio primero, pero \
igual podés responder preguntas generales de mastering.
- No inventes datos del track que no estén en el contexto: si falta algo, decí que no lo tenés.
- No sos un modelo genérico: sos parte de esta app de mastering, mantené el foco en audio, \
mezcla, mastering y el uso de la herramienta.

Rangos válidos de los parámetros de la cadena (para cuando propongas cambios):
{ranges_block}

{audio_context}
"""


def chat(user_message: str, history: Optional[list] = None,
         analysis: Optional[dict] = None, preset: Optional[str] = None,
         platform: Optional[str] = None) -> dict:
    """Envía un mensaje al asistente de IA y devuelve un dict:
    {"reply": str, "suggested_params": dict, "suggestion_summary": Optional[str]}

    `suggested_params` viene vacío ({}) cuando el modelo no propuso ningún ajuste \
    aplicable (p.ej. preguntas teóricas) — el frontend solo debe mostrar el botón \
    de "Aplicar cambios" cuando ese dict tiene contenido.

    `history` es una lista de dicts [{"role": "user"|"assistant", "content": str}, ...]
    con los turnos previos de esta conversación (ya sin el mensaje actual).
    """
    client = _get_client()
    if client is None:
        fallback = build_fallback_response(user_message, analysis)
        return {
            "reply": fallback["reply"],
            "suggested_params": fallback["suggested_params"],
            "suggestion_summary": fallback["suggestion_summary"],
        }

    if not user_message or not user_message.strip():
        raise ValueError("El mensaje está vacío.")

    ranges_block = _param_ranges_text()
    float_field_names = [k for k in PARAM_RANGES if k not in DB_EXPOSED_FIELDS]
    float_field_names += [_db_field_name(k) for k in DB_EXPOSED_FIELDS]
    enum_fields_hint = "\n".join(
        f'- "{field}": string o null, uno de {", ".join(repr(v) for v in values)}.'
        for field, values in STRING_ENUM_FIELDS.items()
    )
    json_fields_hint = (
        "Devolvé SOLO un objeto JSON plano (sin markdown, sin texto extra) con estas claves:\n"
        '- "reply": string, obligatorio, tu respuesta conversacional.\n'
        '- "suggestion_summary": string o null.\n'
        '- "reasoning": string o null. Si proponés parámetros, explicá brevemente por qué y cuál es el fundamento técnico.\n'
        f"- Como número (float) o null si no lo tocás: {', '.join(float_field_names)}.\n"
        f"- Como booleano (true/false) o null si no lo tocás: {', '.join(BOOL_PARAM_FIELDS)}.\n"
        f"{enum_fields_hint}"
    )
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        ranges_block=ranges_block,
        audio_context=build_audio_context(analysis, preset, platform),
    ) + "\n\n" + json_fields_hint

    # Gemini usa roles "user" y "model" (en vez de "assistant").
    contents = []
    for turn in (history or [])[-MAX_HISTORY_MESSAGES:]:
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and content:
            gemini_role = "model" if role == "assistant" else "user"
            contents.append({"role": gemini_role, "parts": [{"text": content}]})
    contents.append({"role": "user", "parts": [{"text": user_message.strip()}]})

    # Llamada liviana (respuesta conversacional + a lo sumo algunos parámetros
    # puntuales, no los ~90 interdependientes de auto-master): thinking
    # explícitamente apagado. Sin esto, gemini-2.5-flash usa thinking dinámico
    # por defecto (igual que el bug de auto-master, ver ahí), y acá el margen
    # es todavía menor (2048 tokens) — más chances de que el JSON se corte a
    # mitad de generación.
    raw = _gemini_generate_content(system_prompt, contents, max_output_tokens=2048, thinking_budget=0)
    data = _extract_json_object(raw) if raw else None
    if data is None and raw is not None:
        logger.warning("Respuesta de chat de Gemini no fue JSON parseable.")

    if not data:
        fallback = build_fallback_response(user_message, analysis)
        return {
            "reply": fallback["reply"],
            "suggested_params": fallback["suggested_params"],
            "suggestion_summary": fallback["suggestion_summary"],
            "suggestion_explanation": fallback.get("suggestion_explanation"),
        }

    reply_text = str(data.get("reply") or "").strip() or (
        "No obtuve respuesta del modelo. Probá reformular la pregunta."
    )

    suggested: dict = {}
    for key, (lo, hi) in PARAM_RANGES.items():
        if key in DB_EXPOSED_FIELDS:
            continue
        v = data.get(key)
        if v is None:
            continue
        try:
            clamped = _clamp(float(v), lo, hi)
        except (TypeError, ValueError):
            continue
        if clamped is not None:
            suggested[key] = round(clamped, 3)
    for key in DB_EXPOSED_FIELDS:
        linear_val = _resolve_db_exposed_param(key, data, default_linear=None)
        if linear_val is not None:
            suggested[key] = round(linear_val, 4)
    for key in BOOL_PARAM_FIELDS:
        v = data.get(key)
        if v is not None:
            suggested[key] = bool(v)
    for field, valid_values in STRING_ENUM_FIELDS.items():
        v = data.get(field)
        if v in valid_values:
            suggested[field] = v

    return {
        "reply": reply_text,
        "suggested_params": suggested,
        "suggestion_summary": (str(data.get("suggestion_summary") or "").strip() or None),
        "suggestion_explanation": (str(data.get("reasoning") or "").strip() or None),
    }


# ═══════════════════════════════════════════════════════════════════════════
# ── Auto-Mastering: la IA toma las decisiones (estilo LANDR AI) ─────────────
# ═══════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════
# ── Auto-Mastering: la IA genera los parámetros de la cadena a mano ─────────
# (ya NO elige entre presets fijos: calcula cada valor en base al análisis)
# ═══════════════════════════════════════════════════════════════════════════

# Rango válido [min, max] para cada parámetro numérico de la cadena de mastering.
# Debe reflejar los mismos límites que valida /master en app.py (Query ge/le),
# para que la IA nunca proponga un valor que el motor de audio vaya a rechazar.
PARAM_RANGES: Dict[str, Tuple[float, float]] = {
    "input_gain_db": (-24.0, 24.0),
    "target_peak": (0.1, 1.0),
    "target_lufs": (-40.0, 0.0),
    "hp_cutoff": (20.0, 500.0),
    "lp_cutoff": (1000.0, 22000.0),
    "high_shelf_gain_db": (-12.0, 12.0),
    "high_shelf_freq_hz": (1000.0, 20000.0),
    "low_shelf_gain_db": (-12.0, 12.0),
    "low_shelf_freq_hz": (20.0, 2000.0),
    "eq1_freq": (20.0, 20000.0), "eq1_gain": (-12.0, 12.0), "eq1_q": (0.1, 10.0),
    "eq2_freq": (20.0, 20000.0), "eq2_gain": (-12.0, 12.0), "eq2_q": (0.1, 10.0),
    "eq3_freq": (20.0, 20000.0), "eq3_gain": (-12.0, 12.0), "eq3_q": (0.1, 10.0),
    "eq4_freq": (20.0, 20000.0), "eq4_gain": (-12.0, 12.0), "eq4_q": (0.1, 10.0),
    "eq5_freq": (20.0, 20000.0), "eq5_gain": (-12.0, 12.0), "eq5_q": (0.1, 10.0),
    "eq6_freq": (20.0, 20000.0), "eq6_gain": (-12.0, 12.0), "eq6_q": (0.1, 10.0),
    "comp_threshold": (0.0, 1.0), "comp_ratio": (1.0, 20.0),
    "comp_attack_ms": (0.1, 200.0), "comp_release_ms": (10.0, 1000.0), "comp_makeup_db": (-12.0, 24.0),
    "transient_attack": (-1.0, 1.0), "transient_sustain": (-1.0, 1.0),
    "mb_low_crossover": (20.0, 2000.0), "mb_high_crossover": (500.0, 20000.0),
    "mb_low_threshold": (0.0, 1.0), "mb_low_ratio": (1.0, 20.0), "mb_low_attack_ms": (0.1, 200.0), "mb_low_release_ms": (10.0, 1000.0), "mb_low_makeup_db": (-12.0, 24.0),
    "mb_mid_threshold": (0.0, 1.0), "mb_mid_ratio": (1.0, 20.0), "mb_mid_attack_ms": (0.1, 200.0), "mb_mid_release_ms": (10.0, 1000.0), "mb_mid_makeup_db": (-12.0, 24.0),
    "mb_high_threshold": (0.0, 1.0), "mb_high_ratio": (1.0, 20.0), "mb_high_attack_ms": (0.1, 200.0), "mb_high_release_ms": (10.0, 1000.0), "mb_high_makeup_db": (-12.0, 24.0),
    "mb_stereo_low_width": (0.0, 3.0), "mb_stereo_mid_width": (0.0, 3.0), "mb_stereo_high_width": (0.0, 3.0),
    "mb_stereo_low_crossover": (20.0, 2000.0), "mb_stereo_high_crossover": (200.0, 20000.0),
    "saturation_drive": (0.0, 1.0), "saturation_mix": (0.0, 1.0),
    "mid_gain_db": (-12.0, 12.0), "side_gain_db": (-18.0, 18.0), "stereo_width_amount": (0.0, 3.0),
    "enhancer_bass_mono_freq": (40.0, 500.0), "haas_delay_ms": (0.0, 30.0),
    "reverb_size": (0.05, 2.0), "reverb_wet": (0.0, 1.0),
    "low_end_mono_freq": (40.0, 300.0), "low_end_mono_amount": (0.0, 1.0),
    "glue_threshold_db": (-24.0, 0.0), "glue_ratio": (1.0, 10.0), "glue_attack_ms": (0.1, 200.0),
    "glue_release_ms": (10.0, 1000.0), "glue_makeup_db": (-12.0, 12.0),
    "clipper_ceiling": (0.1, 1.0), "clipper_drive_db": (0.0, 24.0),
    "dyneq_freq": (200.0, 16000.0), "dyneq_q": (0.5, 12.0), "dyneq_threshold_db": (-60.0, 0.0),
    "dyneq_ratio": (1.0, 20.0), "dyneq_attack_ms": (0.1, 100.0), "dyneq_release_ms": (5.0, 1000.0),
    "dyneq_max_reduction_db": (0.0, 30.0),
    "ms_mid_freq": (20.0, 2000.0), "ms_mid_gain": (-12.0, 12.0), "ms_mid_q": (0.1, 10.0),
    "ms_side_freq": (1000.0, 20000.0), "ms_side_gain": (-12.0, 12.0), "ms_side_q": (0.1, 10.0),
    "ms_comp_mid_threshold_db": (-60.0, 0.0), "ms_comp_mid_ratio": (1.0, 20.0),
    "ms_comp_mid_attack_ms": (0.1, 200.0), "ms_comp_mid_release_ms": (5.0, 2000.0),
    "ms_comp_mid_makeup_db": (0.0, 24.0),
    "ms_comp_side_threshold_db": (-60.0, 0.0), "ms_comp_side_ratio": (1.0, 20.0),
    "ms_comp_side_attack_ms": (0.1, 200.0), "ms_comp_side_release_ms": (5.0, 2000.0),
    "ms_comp_side_makeup_db": (0.0, 24.0),
    "reso_freq": (200.0, 16000.0), "reso_q": (0.5, 12.0), "reso_threshold_db": (-60.0, 0.0),
    "reso_ratio": (1.0, 20.0), "reso_attack_ms": (0.1, 100.0), "reso_release_ms": (5.0, 1000.0),
    "reso_max_reduction_db": (0.0, 30.0),
    "nr_strength": (0.0, 1.0), "nr_noise_sample_sec": (0.1, 5.0),
    "limiter_ceiling": (0.5, 1.0), "limiter_release_ms": (1.0, 500.0),
}
BOOL_PARAM_FIELDS = [
    "use_lufs_normalize", "mb_bypass", "use_stereo_enhancer",
    "lp_bypass", "comp_stereo_link", "mb_stereo_bypass", "glue_bypass",
    "dyneq_bypass", "ms_eq_bypass", "ms_comp_bypass", "reso_bypass", "clipper_bypass", "nr_bypass",
]
SATURATION_MODES = ("tape", "tube")
EQ_MODES = ("iir", "linear_phase")
CLIPPER_MODES = ("soft", "hard")
# Campos de texto libre (no numéricos/booleanos) con un set fijo de valores
# válidos — mismo patrón de validación para los tres, evita que un nuevo
# campo de este tipo repita a mano la lista de opciones en 3 lugares
# distintos (y se desincronice, como pasaba antes con "clipper" apareciendo
# como opción de saturation_mode en el prompt pero no en SATURATION_MODES).
STRING_ENUM_FIELDS: Dict[str, tuple] = {
    "saturation_mode": SATURATION_MODES,
    "eq_mode": EQ_MODES,
    "clipper_mode": CLIPPER_MODES,
}

# Campos de umbral/techo del motor que son ratios lineales de amplitud (0-1,
# relativos a 0dBFS) — nomenclatura técnica interna del DSP. Se los exponemos a
# la IA (y al chat) directamente en dB, que es la escala en la que cualquiera
# razona naturalmente sobre audio, en vez de forzarla a pensar en ratios 0-1.
# El código convierte a la escala lineal real del motor antes de aplicar nada;
# la IA nunca ve ni produce el número lineal.
DB_EXPOSED_FIELDS: Dict[str, Tuple[float, float]] = {
    "target_peak": (-20.0, 0.0),
    "comp_threshold": (-40.0, 0.0),
    "mb_low_threshold": (-40.0, 0.0),
    "mb_mid_threshold": (-40.0, 0.0),
    "mb_high_threshold": (-40.0, 0.0),
    "limiter_ceiling": (-6.0, 0.0),
}


def _db_field_name(key: str) -> str:
    """Nombre del campo tal como lo ve la IA: 'comp_threshold' -> 'comp_threshold_db'."""
    return f"{key}_db"


def _db_to_linear(db_value: float) -> float:
    return 10 ** (db_value / 20.0)


def _linear_to_db(linear_value: float) -> float:
    import math
    return round(20 * math.log10(max(float(linear_value), 1e-6)), 2)
    
import math
def linear_to_db(linear: float) -> float:
    return 20 * math.log10(max(linear, 1e-6))    


# Aclaraciones de escala/unidad para el resto de parámetros que no son dB reales
# (los de DB_EXPOSED_FIELDS ya no necesitan nota: se exponen directamente en dB).
PARAM_NOTES: Dict[str, str] = {
    "saturation_drive": "0–1, cantidad de saturación (no dB). Típico 0.05–0.3.",
    "saturation_mix": "0–1, mezcla dry/wet (no dB). Típico 0.1–0.4.",
    "reverb_wet": "0–1, mezcla dry/wet (no dB). Típico 0–0.1, es mastering, no mezcla.",
    "reverb_size": "0.05–2, tamaño relativo de la reverb (no dB, no segundos).",
    "transient_attack": "-1 a 1, unitless. Negativo = atenúa transitorios, positivo = realza.",
    "transient_sustain": "-1 a 1, unitless. Negativo = atenúa sustain, positivo = realza.",
    "stereo_width_amount": "multiplicador de ancho estéreo, 1.0 = ancho original (no dB, no %).",
    "comp_ratio": "ratio de compresión X:1 (ej. 2.5 = 2.5:1), no dB.",
    "mb_low_ratio": "ratio de compresión X:1, no dB.",
    "mb_mid_ratio": "ratio de compresión X:1, no dB.",
    "mb_high_ratio": "ratio de compresión X:1, no dB.",
    "mb_stereo_low_width": "multiplicador de ancho estéreo SOLO en graves, análogo a stereo_width_amount pero por banda (no dB).",
    "mb_stereo_mid_width": "multiplicador de ancho estéreo SOLO en medios (no dB).",
    "mb_stereo_high_width": "multiplicador de ancho estéreo SOLO en agudos (no dB).",
    "low_end_mono_amount": "0–1, cuánto se monofoniza por debajo de low_end_mono_freq (0=nada, 1=mono total). No dB.",
    "glue_ratio": "ratio de compresión X:1 del glue compressor (bus), no dB.",
    "dyneq_ratio": "ratio de compresión X:1 de la EQ dinámica (de-esser), no dB.",
    "reso_ratio": "ratio de compresión X:1 de la EQ dinámica de resonancias, no dB.",
    "nr_strength": "0–1, intensidad de la reducción de ruido (0=nada, 1=máximo). No dB.",
    "nr_noise_sample_sec": "segundos iniciales del track usados para estimar el perfil de ruido (no dB).",
}


def _param_ranges_text() -> str:
    """Arma el bloque de rangos válidos para el prompt. Los campos de umbral/techo \
    (DB_EXPOSED_FIELDS) se listan ya convertidos a dB, con su nombre '_db' — la IA \
    nunca ve el ratio lineal interno del motor."""
    lines = []
    for key, (lo, hi) in PARAM_RANGES.items():
        if key in DB_EXPOSED_FIELDS:
            continue  # se listan más abajo, en dB
        note = PARAM_NOTES.get(key)
        if note:
            lines.append(f"- {key}: [{lo}, {hi}] — {note}")
        elif key.endswith("_db"):
            lines.append(f"- {key}: [{lo}, {hi}] dB")
        elif key.endswith("_ms"):
            lines.append(f"- {key}: [{lo}, {hi}] ms")
        elif key.endswith(("freq", "crossover", "cutoff")) or key.endswith("_hz"):
            lines.append(f"- {key}: [{lo}, {hi}] Hz")
        else:
            lines.append(f"- {key}: [{lo}, {hi}]")
    for key, (db_lo, db_hi) in DB_EXPOSED_FIELDS.items():
        lines.append(f"- {_db_field_name(key)}: [{db_lo}, {db_hi}] dB, relativo a 0dBFS "
                      f"(el motor lo convierte solo a ratio interno, no calcules vos la conversión)")
    return "\n".join(lines)


def _resolve_db_exposed_param(key: str, data: dict, default_linear: Optional[float] = None):
    """Lee el campo '{key}_db' de la respuesta de la IA, lo clampea en dB y lo \
    convierte a la escala lineal real del motor (PARAM_RANGES[key]). Si no vino \
    en la respuesta, devuelve `default_linear` (ya en escala lineal) sin tocar."""
    db_lo, db_hi = DB_EXPOSED_FIELDS[key]
    lo, hi = PARAM_RANGES[key]
    raw = data.get(_db_field_name(key))
    if raw is None:
        return default_linear
    try:
        db_val = _clamp(float(raw), db_lo, db_hi)
    except (TypeError, ValueError):
        return default_linear
    if db_val is None:
        return default_linear
    linear_val = _clamp(_db_to_linear(db_val), lo, hi)
    return linear_val if linear_val is not None else default_linear


# Valores neutros de partida: no representan ningún género en particular, son
# sólo el punto de referencia que se usa si la IA no está disponible y hay
# que recurrir a la heurística de respaldo (ver _fallback_custom_params).
_NEUTRAL_PARAMS: dict = {
    "input_gain_db": 0.0, "target_peak": 0.95, "use_lufs_normalize": False, "target_lufs": -12.0,
    "hp_cutoff": 35.0, "lp_bypass": True, "lp_cutoff": 18000.0,
    "high_shelf_gain_db": 1.5, "high_shelf_freq_hz": 8000.0,
    "eq1_freq": 100.0, "eq1_gain": 0.0, "eq1_q": 1.0,
    "eq2_freq": 400.0, "eq2_gain": 0.0, "eq2_q": 1.1,
    "eq3_freq": 2500.0, "eq3_gain": 0.0, "eq3_q": 1.0,
    "eq4_freq": 9000.0, "eq4_gain": 0.5, "eq4_q": 0.9,
    "eq5_freq": 200.0, "eq5_gain": 0.0, "eq5_q": 1.0,
    "eq6_freq": 1000.0, "eq6_gain": 0.0, "eq6_q": 1.0,
    "comp_threshold": 0.55, "comp_ratio": 2.2, "comp_attack_ms": 12.0, "comp_release_ms": 120.0, "comp_makeup_db": 1.0,
    "comp_stereo_link": True,
    "transient_attack": 0.0, "transient_sustain": 0.0,
    "mb_bypass": False,
    "mb_low_crossover": 150.0, "mb_high_crossover": 4000.0,
    "mb_low_threshold": 0.60, "mb_low_ratio": 2.0, "mb_low_attack_ms": 20.0, "mb_low_release_ms": 150.0, "mb_low_makeup_db": 0.3,
    "mb_mid_threshold": 0.62, "mb_mid_ratio": 1.8, "mb_mid_attack_ms": 15.0, "mb_mid_release_ms": 120.0, "mb_mid_makeup_db": 0.3,
    "mb_high_threshold": 0.65, "mb_high_ratio": 1.6, "mb_high_attack_ms": 8.0, "mb_high_release_ms": 90.0, "mb_high_makeup_db": 0.2,
    # Multibanda-estéreo, glue, clipper, de-esser y EQ de resonancias arrancan
    # BYPASSEADOS por default: son correcciones/refinamientos puntuales, no
    # algo que todo track necesite — si la IA no tiene motivo para tocarlos
    # (o falla y cae a la heurística), lo correcto es dejarlos apagados en
    # vez de aplicar valores inventados sin que el análisis lo justifique.
    "mb_stereo_bypass": True,
    "mb_stereo_low_width": 0.9, "mb_stereo_mid_width": 1.0, "mb_stereo_high_width": 1.0,
    "mb_stereo_low_crossover": 150.0, "mb_stereo_high_crossover": 4000.0,
    "saturation_drive": 0.1, "saturation_mode": "tape", "saturation_mix": 0.2,
    "mid_gain_db": 0.0, "side_gain_db": 0.0, "stereo_width_amount": 1.05,
    "use_stereo_enhancer": False, "enhancer_bass_mono_freq": 120.0, "haas_delay_ms": 0.0,
    "reverb_size": 0.2, "reverb_wet": 0.02,
    "low_end_mono_freq": 120.0, "low_end_mono_amount": 0.0,
    "glue_bypass": True,
    "glue_threshold_db": -4.0, "glue_ratio": 2.0, "glue_attack_ms": 30.0, "glue_release_ms": 120.0, "glue_makeup_db": 0.0,
    "clipper_bypass": True, "clipper_mode": "soft", "clipper_ceiling": 0.98, "clipper_drive_db": 0.0,
    "dyneq_bypass": True,
    "dyneq_freq": 3000.0, "dyneq_q": 2.5, "dyneq_threshold_db": -18.0,
    "dyneq_ratio": 3.0, "dyneq_attack_ms": 3.0, "dyneq_release_ms": 80.0, "dyneq_max_reduction_db": 12.0,
    "ms_eq_bypass": True,
    "ms_mid_freq": 250.0, "ms_mid_gain": 0.0, "ms_mid_q": 1.0,
    "ms_side_freq": 8000.0, "ms_side_gain": 0.0, "ms_side_q": 1.0,
    "ms_comp_bypass": True,
    "ms_comp_mid_threshold_db": -18.0, "ms_comp_mid_ratio": 2.0,
    "ms_comp_mid_attack_ms": 15.0, "ms_comp_mid_release_ms": 120.0, "ms_comp_mid_makeup_db": 0.0,
    "ms_comp_side_threshold_db": -18.0, "ms_comp_side_ratio": 2.0,
    "ms_comp_side_attack_ms": 15.0, "ms_comp_side_release_ms": 120.0, "ms_comp_side_makeup_db": 0.0,
    "reso_bypass": True,
    "reso_freq": 1200.0, "reso_q": 3.0, "reso_threshold_db": -18.0,
    "reso_ratio": 3.0, "reso_attack_ms": 5.0, "reso_release_ms": 100.0, "reso_max_reduction_db": 8.0,
    "nr_bypass": True, "nr_strength": 0.5, "nr_noise_sample_sec": 0.5,
    "eq_mode": "iir",
    "limiter_ceiling": 0.96, "limiter_release_ms": 55.0,
}

AUTO_MASTER_SYSTEM_PROMPT = """Sos Laia, la ingeniera de mastering de IA integrada en la app MASTER. \
Tu trabajo es decidir de forma 100% autónoma CADA parámetro de la cadena de mastering para el \
track del usuario, con el mismo criterio, cuidado y "consciencia" que aplicaría una ingeniera de \
mastering de estudio de primer nivel escuchando y midiendo el track antes de tocar un solo knob. \
El usuario no va a tocar nada manualmente: confía por completo en tu criterio profesional. \
Trabajás en cuatro fases, en este orden, y tu reasoning final debe reflejar ese razonamiento:

FASE 1 — ANÁLISIS: ya tenés decenas de métricas reales del track (ver más abajo): loudness \
integrado y de corto plazo, true peak, PLR, LRA, dinámica global y por banda (graves/medios/agudos), \
balance espectral de 7 bandas + centroid/rolloff/flatness, correlación estéreo global y por banda, \
compatibilidad mono, DC offset, clipping, silencio y densidad de transientes. Leelas todas \
antes de decidir nada: son tu diagnóstico, no un formulario a ignorar.

FASE 2 — DECISIÓN INTELIGENTE: a partir de ese diagnóstico, identificá los 2-4 problemas o \
características más importantes de ESTE track puntual (p.ej. "muy comprimido y con exceso de \
graves", o "dinámico pero apagado en agudos", o "buena dinámica, sólo necesita loudness") y \
definí una estrategia de mastering coherente con eso: qué tan agresiva debe ser la compresión, \
si conviene EQ correctiva o de color, cuánto loudness final tiene sentido para el carácter del \
track (no todo tiene que llegar a -6 LUFS), y si el estéreo/saturación necesitan ajuste. \
Dos tracks distintos con métricas distintas DEBEN terminar con parámetros distintos — nunca \
apliques siempre la misma combinación "por defecto".

FASE 3 — CONSTRUCCIÓN DE LA CADENA DSP: traducí la estrategia de la Fase 2 a valores concretos \
de cada etapa de la cadena (en este orden de señal: input gain → high-pass/low-pass → EQ correctiva \
(6 bandas paramétricas, eq1..eq6) + de-esser (dyneq_*) + EQ dinámica de resonancias (reso_*) → EQ \
M/S (ms_*) → compresor de banda ancha → tonal shelf/EQ de color → multibanda (mb_*) → transient \
shaper → saturación → estéreo (mid/side, ancho, multibanda mb_stereo_*, enhancer/haas) → sub-bass \
mono (low_end_mono_*) → glue compressor (glue_*) → clipper → limiter). Guía de criterio (no son \
reglas rígidas, usalas con sentido común de ingeniería, cruzando SIEMPRE con los números reales \
del análisis):
- Dinámica: si dynamic_range_db o el crest factor por banda ya son bajos (muy comprimido), usá \
compresión y limiter más suaves para no sobre-comprimir; si son altos, podés compensar con más \
ratio/threshold más bajo. LRA muy chico también es señal de sobre-compresión previa.
- Balance espectral: corregí excesos o faltantes de energía en sub-bajos/bajos/medios/presencia/aire \
con hp_cutoff, high_shelf_gain_db/freq_hz y las 6 bandas de EQ paramétrico (eqN_freq/gain/q). El \
centroid y rolloff espectral te dicen si el track suena "oscuro" o "brillante" en términos objetivos. \
Usá eq_mode="linear_phase" SOLO si necesitás una corrección quirúrgica (corte angosto, alto Q) donde \
la fase importa; para EQ de color amplio, iir es más liviano y suena igual de bien.
- De-esser y resonancias (dyneq_*, reso_*): son EQ dinámica, no estática — solo actúan cuando la \
señal supera el threshold en esa frecuencia puntual. Activalos (bypass=false) SOLO si el análisis \
sugiere sibilancia o resonancias problemáticas puntuales (picos angostos y consistentes en el \
balance espectral, spectral_flatness muy baja en una zona acotada); no los uses como reemplazo de \
la EQ estática de banda ancha.
- EQ M/S (ms_*): correctivo fino de mid vs. side, independiente del ancho estéreo general. Útil \
p.ej. para bajar graves del side (mantenerlos centrados) sin tocar los graves del mid. Dejalo \
bypasseado salvo que el análisis de correlación por banda lo justifique.
- Estéreo: si mono_compatibility_db es muy negativo o la correlación por banda en graves es baja, \
NO ensanches más el estéreo (dejá stereo_width_amount y mb_stereo_*_width cerca de 1.0), activá \
low_end_mono_amount (mono forzado por debajo de low_end_mono_freq) y considerá enhancer_bass_mono_freq \
más alto para mantener los graves centrados. Los parámetros multibanda (mb_*, mb_stereo_*) y mid/side \
son correcciones finas; no los actives agresivamente salvo que el análisis lo justifique.
- Glue compressor (glue_*): compresión de bus muy suave (ratio bajo, threshold alto) para "pegar" el \
mix antes del limiter — no es un segundo compresor de banda ancha agresivo. Útil en mixes con \
elementos que suenan desconectados entre sí; conservador con el resto.
- Clipper: recorte previo al limiter para quitar picos puntuales sin que el limiter tenga que \
trabajar tanto (menos pumping). Usalo con drive bajo (unos pocos dB) si true_peak_db/clipping_ratio \
ya muestran el track muy caliente y el limiter solo no alcanza sin sonar forzado; clipper_mode="hard" \
es más agresivo/audible que "soft".
- True peak / clipping: si true_peak_db o clipping_ratio ya muestran problemas, usá limiter_ceiling_db \
más conservador (≤ -0.5 dB aprox.) y no agregues makeup gain innecesario.
- Densidad de transientes: material muy percusivo (transient_density alta, trap/metal) tolera \
attack del compresor más lento y más transient shaping; material sostenido (baladas, ambient) pide \
attack más rápido y compresión más suave para no aplastar el groove.
- Loudness objetivo y ceiling del limiter: dependen de la plataforma elegida (si elegís una) y de \
cuánto necesita "calentarse" el track según su LUFS actual y su PLR (un PLR alto = mucho margen \
para subir loudness sin destruir la dinámica; un PLR bajo = ya está caliente, sé conservador).
- Reducción de ruido (nr_*): SOLO si hay ruido de fondo real evidente en el análisis (silence_ratio \
alto con piso de ruido notable, o el usuario lo menciona); no es parte del mastering normal.
- Sé conservador con saturación, reverb y haas: son color, no arreglos — nunca la solución a un \
problema técnico real.

FASE 4 — OPTIMIZACIÓN: después de tu decisión, el sistema renderiza un preview real con estos \
parámetros y vuelve a medir LUFS y true peak logrados. Si no coinciden con el objetivo, se hace \
una corrección automática de gain-staging (makeup del compresor / input gain) sin tocar tu \
diseño tonal ni dinámico — no necesitás simular esto vos, sólo saber que existe: por eso es más \
importante que definas bien EQ, dinámica y estéreo que perseguir un LUFS exacto de memoria.

Rangos válidos (el motor de audio rechaza cualquier valor fuera de estos límites, así que \
mantenete siempre dentro de ellos):
{ranges_block}

saturation_mode sólo puede ser "tape" o "tube". Los campos use_lufs_normalize, mb_bypass y \
use_stereo_enhancer son booleanos (true/false).

Respondé ÚNICAMENTE con un objeto JSON, sin texto adicional, sin markdown, con TODOS los campos \
numéricos/booleanos de la cadena (los mismos que se listan en los rangos de arriba, más \
saturation_mode), y además:
{{
  "platform": "<una de las plataformas listadas abajo, EXACTAMENTE como está escrita, o null>",
  "reasoning": "<4-6 oraciones en español rioplatense explicando el diagnóstico (Fase 1-2) y las \
decisiones más importantes de la cadena (Fase 3) que tomaste, citando los números concretos del \
análisis (LUFS, true peak, dinámica por banda, balance espectral, estéreo, etc.) y por qué \
elegiste esos valores puntuales de compresor/EQ/limiter>"
}}

Plataformas / targets de loudness disponibles: {platforms_block}

{audio_context}
"""


def _clamp(value, lo, hi):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, value))


def _parse_instruction_params(user_message: str) -> dict:
    """Traduce instrucciones en lenguaje natural a parámetros de la cadena DSP.

    Ejemplos soportados:
    - 'dame 2 db menos en 4k q 1.2' -> EQ banda 3 con gain -2 dB, freq 4k, Q 1.2
    - 'subí 1.5 dB el aire' -> high_shelf_gain_db +1.5
    - 'más compresión' -> comp_ratio/comp_threshold más agresivos
    - 'más reverb' -> reverb_wet +0.04
    """
    message = (user_message or "").strip().lower()
    if not message:
        return {}

    params: dict = {}
    summary = None
    reply = None

    def add_param(key, value):
        if value is None:
            return
        if isinstance(value, bool):
            params[key] = value
        elif isinstance(value, str):
            params[key] = value
        else:
            params[key] = round(float(value), 4)

    # --- Gain / level parsing ---
    gain_match = re.search(r'([+-]?\d+(?:[.,]\d+)?)\s*(?:db|dB|decibeles|decibel)', message)
    gain_db = None
    if gain_match:
        gain_db = float(gain_match.group(1).replace(",", "."))
        if re.search(r'\b(menos|bajar|bajá|bajale|restar|cut|down)\b', message):
            gain_db = -abs(gain_db)
        elif re.search(r'\b(subir|subi|subile|aumentar|agregar|boost|up|más)\b', message):
            gain_db = abs(gain_db)

    # --- Frequency parsing ---
    freq_hz = None
    freq_match = re.search(r'(\d+(?:[.,]\d+)?)\s*(k|khz|hz)', message)
    if freq_match:
        val = float(freq_match.group(1).replace(",", "."))
        unit = freq_match.group(2).lower()
        if unit in {"k", "khz"}:
            freq_hz = val * 1000.0
        else:
            freq_hz = val

    # --- Q parsing ---
    q_value = None
    q_match = re.search(r'(?:q|q=|q:|q\s*)(\d+(?:[.,]\d+)?)', message)
    if q_match:
        q_value = float(q_match.group(1).replace(",", "."))

    # --- EQ instruction: 'en 4k', 'en 8k', '2 db menos en 4k q 1.2' ---
    if gain_db is not None and ("eq" in message or freq_hz is not None or "4k" in message or "8k" in message or "khz" in message):
        if freq_hz is None and gain_db is not None:
            freq_hz = 4000.0 if "4k" in message or "4 khz" in message else 8000.0 if "8k" in message or "8 khz" in message else None
        if freq_hz is not None:
            if freq_hz <= 180.0:
                band_key = "eq1"
            elif freq_hz <= 1000.0:
                band_key = "eq2"
            elif freq_hz <= 3000.0:
                band_key = "eq3"
            else:
                band_key = "eq4"
            add_param(f"{band_key}_freq", freq_hz)
            add_param(f"{band_key}_gain", gain_db)
            if q_value is not None:
                add_param(f"{band_key}_q", q_value)
            summary = "Ajuste de EQ paramétrico"
            reply = f"Ajusté la banda de EQ en {int(freq_hz/1000)} kHz con {gain_db:+.1f} dB."

    # --- Shelf / air / brilliance ---
    if gain_db is not None and ("aire" in message or "brillo" in message or "agudos" in message or "high shelf" in message):
        add_param("high_shelf_gain_db", gain_db)
        if summary is None:
            summary = "Ajuste de aire en agudos"
            reply = f"Subí el shelf de agudos en {gain_db:+.1f} dB."

    # --- Compression controls ---
    if "compres" in message or "compress" in message or "compression" in message:
        if gain_db is not None and ("threshold" in message or "umbral" in message or "thresh" in message):
            add_param("comp_threshold", _db_to_linear(gain_db))
            summary = summary or "Ajuste de compresión"
            reply = reply or f"Cambié el threshold del compresor a {gain_db:+.1f} dB."
        elif "ratio" in message or "ratio" in message:
            ratio_match = re.search(r'(\d+(?:[.,]\d+)?)\s*(?:x|:1|ratio)', message)
            if ratio_match:
                add_param("comp_ratio", float(ratio_match.group(1).replace(",", ".")))
                summary = summary or "Ajuste de ratio"
        elif "attack" in message or "ataque" in message:
            ms_match = re.search(r'(\d+(?:[.,]\d+)?)\s*(ms|miliseg)', message)
            if ms_match:
                add_param("comp_attack_ms", float(ms_match.group(1).replace(",", ".")))
        elif "release" in message or "release" in message or "soltar" in message:
            ms_match = re.search(r'(\d+(?:[.,]\d+)?)\s*(ms|miliseg)', message)
            if ms_match:
                add_param("comp_release_ms", float(ms_match.group(1).replace(",", ".")))

    # --- Saturation ---
    if "satur" in message or "drive" in message:
        if gain_db is not None:
            add_param("saturation_drive", max(0.0, min(1.0, abs(gain_db) / 12.0)))
            summary = summary or "Ajuste de saturación"

    # --- Stereo / width ---
    if "ancho" in message or "estéreo" in message or "width" in message:
        width_match = re.search(r'(\d+(?:[.,]\d+)?)\s*(x|times)', message)
        if width_match:
            add_param("stereo_width_amount", float(width_match.group(1).replace(",", ".")))
        elif gain_db is not None:
            add_param("stereo_width_amount", max(0.0, min(3.0, 1.0 + gain_db / 6.0)))

    # --- Reverb ---
    if "reverb" in message or "verb" in message:
        if gain_db is not None:
            add_param("reverb_wet", max(0.0, min(1.0, abs(gain_db) / 12.0)))
        else:
            add_param("reverb_wet", 0.08)

    # --- Limiter / ceiling / loudness ---
    if "limiter" in message or "techo" in message or "pico" in message:
        if gain_db is not None:
            add_param("limiter_ceiling", _db_to_linear(gain_db))
            summary = summary or "Ajuste de limiter"
    if "loud" in message or "lufs" in message or "fuerte" in message or "más fuerte" in message:
        if gain_db is not None:
            add_param("comp_makeup_db", gain_db)
            summary = summary or "Ajuste de loudness"

    # --- Parámetros avanzados / modos de cadena ---
    if "linear phase" in message or "phase linear" in message or "linear_phase" in message:
        add_param("eq_mode", "linear_phase")
    if "iir" in message:
        add_param("eq_mode", "iir")
    if "glue" in message and ("bypass" in message or "desactiv" in message or "apag" in message):
        add_param("glue_bypass", True)
    if "glue" in message and ("activar" in message or "encend" in message or "on" in message):
        add_param("glue_bypass", False)
    if "multibanda" in message and ("bypass" in message or "desactiv" in message or "apag" in message):
        add_param("mb_bypass", True)
    if "multibanda" in message and ("activar" in message or "encend" in message or "on" in message):
        add_param("mb_bypass", False)
    if "estéreo" in message and ("enhancer" in message or "estereo enhancer" in message):
        add_param("use_stereo_enhancer", True)
    if "enhancer" in message and ("bypass" in message or "desactiv" in message or "apag" in message):
        add_param("use_stereo_enhancer", False)
    if "link" in message and "stereo" in message and ("activar" in message or "on" in message):
        add_param("comp_stereo_link", True)
    if "link" in message and "stereo" in message and ("desactiv" in message or "apag" in message):
        add_param("comp_stereo_link", False)
    if "oversample" in message or "oversampling" in message:
        if "bajo" in message or "draft" in message or "fast" in message or "rapido" in message:
            add_param("oversample_mode", "fast")
        elif "alta" in message or "quality" in message or "calidad" in message or "ultra" in message:
            add_param("oversample_mode", "quality")
        else:
            add_param("oversample_mode", "quality")

    return params if params else {}


def build_fallback_response(user_message: str, analysis: Optional[dict]) -> dict:
    """Respuesta de respaldo útil cuando la IA externa no está disponible o no
    devuelve cambios accionables. Genera sugerencias simples pero realistas basadas
    en el análisis y en palabras claves del mensaje del usuario."""
    message = (user_message or "").strip().lower()
    parsed_params = _parse_instruction_params(user_message)
    if parsed_params:
        reply = f"Aplicaré ese ajuste directamente en la cadena DSP: {', '.join(parsed_params.keys())}."
        return {
            "reply": reply,
            "suggested_params": parsed_params,
            "suggestion_summary": "Ajuste DSP guiado por texto",
            "suggestion_explanation": reply,
        }

    a = analysis or {}
    spectrum = a.get("spectrum") or {}
    advice = a.get("mix_advice") or {}
    issues = [str(i).lower() for i in (advice.get("issues") or [])]
    tips = [str(t).lower() for t in (advice.get("tips") or [])]
    lufs = a.get("lufs")
    peak = a.get("peak_db")
    true_peak = a.get("true_peak_db")

    suggested: dict = {}
    summary = None
    reply = "Te propongo un ajuste conservador según el análisis del track."

    def pick(value, key):
        if value is None:
            return
        suggested[key] = round(float(value), 3)

    wants_brighter = any(k in message for k in ["brillo", "aire", "agudos", "bright", "shine", "más brillo"])
    wants_louder = any(k in message for k in ["más fuerte", "louder", "subilo", "subir", "loudness", "más loud"])
    wants_less_comp = any(k in message for k in ["menos comp", "menos compresión", "suave", "más natural", "relajá"])
    wants_more_warmth = any(k in message for k in ["calido", "warm", "grave", "graves", "bajo"])
    wants_less_clipping = any(k in message for k in ["clipping", "pico", "techo", "limitar", "limiter"])

    if wants_brighter or any("altas frecuencias muy bajas" in i for i in issues) or any("high shelf" in t for t in tips):
        boost = 2.0 if (spectrum.get("air") is not None and float(spectrum.get("air", -999)) < -24) else 1.5
        pick(boost, "high_shelf_gain_db")
        pick(min(2.0, max(0.8, boost - 0.4)), "eq4_gain")
        summary = "Más aire y brillo en agudos"
        reply = "Voy a sumar un poco de aire en los agudos para que el track se vea más abierto y brillante."

    if wants_louder or (isinstance(lufs, (int, float)) and lufs < -18):
        if isinstance(lufs, (int, float)) and lufs < -20:
            pick(-12.0, "target_lufs")
            pick(1.5, "comp_makeup_db")
            summary = summary or "Subir loudness con más control"
            reply = "El track está bastante abajo en loudness, así que priorizo un lift de nivel con compresión y limiter más controlados."
        else:
            pick(-14.0, "target_lufs")
            pick(0.8, "comp_makeup_db")
            summary = summary or "Subir loudness sin perder cuerpo"
            reply = "Voy a empujar un poco el nivel general para que quede más presente sin perder demasiada dinámica."

    if wants_less_comp or any("muy comprimido" in i or "muy comprimido" in t for i, t in zip(issues, tips)):
        pick(0.65, "comp_threshold")
        pick(2.0, "comp_ratio")
        summary = summary or "Compresión más natural"
        reply = "Voy a aflojar un poco la compresión para que el track se sienta menos aplastado."

    if wants_more_warmth or (spectrum.get("bass") is not None and float(spectrum.get("bass", -999)) < -18):
        pick(45.0, "hp_cutoff")
        pick(1.2, "eq1_gain")
        summary = summary or "Más cuerpo en bajos"
        reply = "Voy a reforzar la zona de bajos y limpiar un poco el extremo grave para que suene más sólido."

    if wants_less_clipping or ((isinstance(true_peak, (int, float)) and true_peak > -0.5) or (isinstance(peak, (int, float)) and peak > -0.5)):
        pick(0.94, "limiter_ceiling")
        pick(50.0, "limiter_release_ms")
        summary = summary or "Más margen de pico"
        reply = "Voy a bajar un poco el techo del limiter para reducir riesgo de clipping y proteger la salida."

    if not suggested:
        if isinstance(lufs, (int, float)) and lufs < -18:
            pick(-14.0, "target_lufs")
            pick(0.8, "comp_makeup_db")
            summary = "Subir loudness con más control"
        elif any("pico" in i for i in issues):
            pick(0.94, "limiter_ceiling")
            summary = "Reducir riesgo de clipping"
        elif any("muy bajo" in i for i in issues):
            pick(1.0, "high_shelf_gain_db")
            summary = "Aumentar claridad general"

    return {
        "reply": reply,
        "suggested_params": suggested,
        "suggestion_summary": summary,
        "suggestion_explanation": reply,
    }


def _fallback_custom_params(analysis: Optional[dict]) -> dict:
    """Heurística de respaldo (sin IA): parte de valores neutros y los ajusta \
    a mano según el análisis real del track, con el mismo criterio que aplicaría \
    un ingeniero de mastering — no un preset fijo ni un par de umbrales binarios:

    - Compresor de banda ancha y limiter: interpolación continua sobre el rango \
    dinámico global (no solo dos casos "muy comprimido"/"muy dinámico").
    - Compresor MULTIBANDA: reacciona al crest factor de CADA banda por separado \
    (antes esto quedaba siempre en el valor neutro, sin importar el análisis).
    - Ancho estéreo: se ajusta según la correlación L/R que YA tiene el track, \
    en vez de aplicar siempre el mismo 1.05 sin mirar nada.
    - Sub-bass mono: activado con una cantidad proporcional a qué tan \
    descorrelacionados están los graves (band_stereo_correlation.low) — \
    práctica estándar de mastering para compatibilidad mono/club/vinilo.
    - Glue compressor: activado MUY suave sólo si el track todavía tiene \
    margen dinámico real (si ya viene comprimido, se deja bypasseado para \
    no sobre-procesar).
    - Clipper: activado con drive mínimo sólo si el track ya viene "caliente" \
    (true peak alto o clipping real detectado), para aliviarle trabajo al \
    limiter sin agregarlo a un master que no lo necesita.
    - De-esser y corrección de resonancias: NO son una estimación a ojo — se \
    reusa `recommend_dynamic_eq()` de mastering.py, que corre detección real \
    de picos espectrales anómalos (resonancias) y de sibilancia sobre las \
    métricas que analyze_audio ya calculó (`analysis["resonances"]`/\
    `["sibilance"]`), y sólo se activan si hay algo puntual que corregir.
    """
    p = dict(_NEUTRAL_PARAMS)
    a = analysis or {}

    def f(key):
        v = a.get(key)
        return float(v) if isinstance(v, (int, float)) else None

    def clamp_key(key, value):
        lo, hi = PARAM_RANGES[key]
        return round(float(min(max(value, lo), hi)), 3)

    lufs = f("lufs")
    plr = f("plr_db")
    dyn = f("dynamic_range_db")
    true_peak = f("true_peak_db")
    clipping_ratio = f("clipping_ratio") or 0.0
    stereo_corr = f("stereo_correlation")
    band_dyn = a.get("band_dynamics_db") or {}
    band_corr = a.get("band_stereo_correlation") or {}
    spectrum = a.get("spectrum") or {}

    def lerp_t(value, lo, hi):
        """0.0 en value<=lo, 1.0 en value>=hi, interpolación lineal entre medio."""
        if value is None:
            return 0.5  # sin dato -> punto medio, no un extremo arbitrario
        return max(0.0, min(1.0, (value - lo) / (hi - lo)))

    # ── Dinámica global: compresor de banda ancha + limiter ──────────────────
    # t=0 en dyn<=6 (ya muy comprimido -> tocar lo mínimo posible), t=1 en
    # dyn>=18 (muy dinámico -> puede tolerar más ratio/threshold más bajo).
    # Interpolación continua: dyn=12 da un resultado intermedio real, no un
    # salto binario entre dos presets fijos.
    t = lerp_t(dyn, 6.0, 18.0)
    p["comp_ratio"] = clamp_key("comp_ratio", 1.6 + t * (3.1 - 1.6))
    p["comp_threshold"] = clamp_key("comp_threshold", 0.72 - t * (0.72 - 0.42))
    p["limiter_release_ms"] = clamp_key("limiter_release_ms", 85.0 - t * (85.0 - 35.0))

    # ── Dinámica POR BANDA: compresor multibanda ──────────────────────────────
    # Antes esto NUNCA se tocaba acá (siempre quedaba en el valor neutro). Cada
    # banda reacciona a SU propio crest factor — un track con graves ya
    # apretados pero agudos sueltos (muy común) recibe tratamiento distinto
    # por banda, en vez de una única decisión global aplicada a las tres.
    def band_comp(band_key, base_threshold, base_ratio):
        dv = band_dyn.get(band_key)
        dv = float(dv) if isinstance(dv, (int, float)) else None
        bt = lerp_t(dv, 5.0, 15.0)
        thr = clamp_key(f"mb_{band_key}_threshold", base_threshold + 0.12 - bt * 0.24)
        ratio = clamp_key(f"mb_{band_key}_ratio", base_ratio - 0.4 + bt * 1.4)
        return thr, ratio

    p["mb_low_threshold"], p["mb_low_ratio"] = band_comp("low", 0.60, 2.0)
    p["mb_mid_threshold"], p["mb_mid_ratio"] = band_comp("mid", 0.62, 1.8)
    p["mb_high_threshold"], p["mb_high_ratio"] = band_comp("high", 0.65, 1.6)

    # ── Loudness/headroom: makeup y ceiling del limiter ───────────────────────
    # PLR (true peak - LUFS) es mejor indicador de headroom real que el LUFS
    # solo: un track a -14 LUFS con PLR alto todavía tiene margen; el mismo
    # LUFS con PLR bajo ya está "caliente" y conviene ser conservador.
    if lufs is not None:
        if lufs < -20:
            p["comp_makeup_db"] = clamp_key("comp_makeup_db", 2.5)
            p["limiter_ceiling"] = clamp_key("limiter_ceiling", 0.97)
        elif lufs > -9:
            p["comp_makeup_db"] = clamp_key("comp_makeup_db", 0.0)
            p["limiter_ceiling"] = clamp_key("limiter_ceiling", 0.95)
    if plr is not None and plr < 8.0:
        # Poco margen real entre pico y loudness -> ya está bastante limitado,
        # ser más conservador con el techo pase lo que diga el LUFS solo.
        p["limiter_ceiling"] = clamp_key("limiter_ceiling", min(p["limiter_ceiling"], 0.95))

    # ── Balance espectral: EQ estática ────────────────────────────────────────
    def band(key):
        v = spectrum.get(key)
        return v if isinstance(v, (int, float)) else None

    sub = band("sub_bass"); bass = band("bass"); air = band("air"); presence = band("presence")
    if sub is not None and sub > -6:
        p["hp_cutoff"] = 45.0
    if bass is not None and bass < -18:
        p["eq1_gain"] = 2.0
    if presence is not None and presence < -20:
        p["eq3_gain"] = 1.5
    if air is not None and air < -24:
        p["high_shelf_gain_db"] = 3.0
        p["eq4_gain"] = 1.5

    # ── Ancho estéreo: parte de lo que el track YA tiene, no de un fijo ───────
    if stereo_corr is not None:
        if stereo_corr < 0.3:
            # Ya muy ancho/con riesgo de fase -> no ensanchar más.
            p["stereo_width_amount"] = clamp_key("stereo_width_amount", 1.0)
        elif stereo_corr > 0.9:
            # Casi mono -> un ensanche leve es seguro y suele sumar.
            p["stereo_width_amount"] = clamp_key("stereo_width_amount", 1.15)

    # ── Sub-bass mono (NUEVO): activado según qué tan centrados están los ────
    # graves. Es una corrección estándar de mastering (compatibilidad mono en
    # sistemas de club/vinilo/PA), no algo exótico — la cantidad escala con
    # band_stereo_correlation.low en vez de ser todo-o-nada.
    low_corr = band_corr.get("low")
    low_corr = float(low_corr) if isinstance(low_corr, (int, float)) else None
    if low_corr is not None and low_corr < 0.85:
        severity = lerp_t(low_corr, 0.3, 0.85)  # 1.0 = grave muy descorrelacionado
        p["low_end_mono_freq"] = 120.0
        p["low_end_mono_amount"] = clamp_key("low_end_mono_amount", 0.4 + (1.0 - severity) * 0.5)

    # ── Glue compressor (NUEVO): sólo si hay margen dinámico real para ────────
    # "pegar" el mix sin sobre-comprimir un track que ya viene apretado.
    if dyn is not None and dyn >= 9.0:
        p["glue_bypass"] = False
        p["glue_threshold_db"] = -14.0
        p["glue_ratio"] = 1.8
        p["glue_attack_ms"] = 30.0
        p["glue_release_ms"] = 130.0
        p["glue_makeup_db"] = 0.3

    # ── Clipper (NUEVO): sólo si el track ya viene caliente (true peak alto o ─
    # clipping real detectado) — ahí un clip suave previo al limiter reduce el
    # trabajo/pumping del limiter. En un track con headroom normal, no aporta
    # nada y sólo agregaría distorsión innecesaria.
    if (true_peak is not None and true_peak > -1.0) or clipping_ratio > 0.001:
        p["clipper_bypass"] = False
        p["clipper_mode"] = "soft"
        p["clipper_ceiling"] = 0.97
        p["clipper_drive_db"] = 1.5

    # ── De-esser y corrección de resonancias (NUEVO): detección real, no ──────
    # a ojo. analyze_audio() ya corrió detect_resonances()/detect_sibilance();
    # acá se reusan esos resultados (sin volver a tocar audio/sr) para armar
    # los mismos parámetros reso_*/dyneq_* que usaría el flujo manual.
    try:
        from mastering import recommend_dynamic_eq
        dyneq_reco = recommend_dynamic_eq(
            None, None, resonances=a.get("resonances"), sibilance=a.get("sibilance"),
        )
        p.update(dyneq_reco.get("recommended_params") or {})
    except Exception as e:
        logger.warning(f"Heurística de respaldo: no se pudo aplicar recommend_dynamic_eq: {e}")

    return p


def _resolve_target_lufs(result: dict) -> Optional[float]:
    """Determina el LUFS objetivo de la Fase 4 (Optimización): el de la plataforma \
    elegida si hay una, si no el target_lufs que la propia IA/heurística calculó."""
    from mastering import PLATFORM_LOUDNESS_TARGETS

    platform = result.get("platform")
    if platform and platform in PLATFORM_LOUDNESS_TARGETS:
        return float(PLATFORM_LOUDNESS_TARGETS[platform]["lufs"])
    target = result.get("target_lufs")
    try:
        return float(target)
    except (TypeError, ValueError):
        return None


def _optimize_gain_staging(result: dict, audio, sr, max_iters: int = 2, tolerance_db: float = 0.4) -> list:
    """FASE 4 — Optimización: renderiza un preview real (~25s, del medio del track) con \
    los parámetros que decidió la IA (o la heurística de respaldo), mide el LUFS \
    realmente logrado por la cadena completa y corrige el makeup gain del compresor de \
    banda ancha si hace falta, iterando hasta converger. No toca EQ, dinámica multibanda \
    ni estéreo — sólo hace el gain-staging fino que una ingeniera de mastering haría de \
    oído después de escuchar el primer render. Se salta silenciosamente si no hay audio \
    disponible o no hay un LUFS objetivo definido (nada que optimizar)."""
    if audio is None or sr is None:
        return []
    target_lufs = _resolve_target_lufs(result)
    if target_lufs is None:
        return []

    from mastering import apply_mastering_chain, _crop_preview

    chain_keys = set(PARAM_RANGES.keys()) | set(BOOL_PARAM_FIELDS) | set(STRING_ENUM_FIELDS.keys())
    try:
        preview = _crop_preview(audio, sr, 25.0)
    except Exception as e:
        logger.warning(f"Optimización (Fase 4) abortada, no se pudo recortar preview: {e}")
        return []
    if preview.shape[-1] < sr * 2:
        return []  # track demasiado corto para un preview útil

    notes = []
    for i in range(max_iters):
        chain_params = {k: v for k, v in result.items() if k in chain_keys}
        try:
            _, meters = apply_mastering_chain(preview, sr, oversample_mode="fast", **chain_params)
        except Exception as e:
            logger.warning(f"Optimización (Fase 4) abortada, no se pudo renderizar preview: {e}")
            break
        achieved = meters.get("post_limiter", {}).get("lufs")
        if achieved is None:
            break
        delta = target_lufs - achieved
        if abs(delta) <= tolerance_db:
            notes.append(
                f"Optimización: preview verificado en {achieved:.1f} LUFS vs. objetivo "
                f"{target_lufs:.1f} LUFS (dentro de tolerancia, sin corrección adicional)."
            )
            break
        old_makeup = float(result.get("comp_makeup_db", 0.0))
        new_makeup = _clamp(old_makeup + delta, *PARAM_RANGES["comp_makeup_db"])
        if new_makeup is None:
            break
        result["comp_makeup_db"] = round(new_makeup, 3)
        notes.append(
            f"Optimización #{i + 1}: el preview dio {achieved:.1f} LUFS vs. objetivo "
            f"{target_lufs:.1f} LUFS → se corrigió el makeup gain del compresor en {delta:+.1f} dB."
        )
        if abs(new_makeup - old_makeup) < 0.05:
            break  # tocó el límite del rango, no tiene sentido seguir iterando
    return notes


def _apply_optimization(result: dict, audio, sr) -> dict:
    """Corre la Fase 4 y, si hubo correcciones, las suma al reasoning que ya trae `result`."""
    try:
        notes = _optimize_gain_staging(result, audio, sr)
    except Exception as e:
        logger.warning(f"Optimización (Fase 4) falló, se devuelve la decisión sin ajustar: {e}")
        notes = []
    if notes:
        base = (result.get("reasoning") or "").rstrip()
        if base and not base.endswith((".", "!", "?")):
            base += "."
        result["reasoning"] = (base + " " + " ".join(notes)).strip()
    return result


def decide_mastering(analysis: Optional[dict], platform_options: list,
                      audio=None, sr: Optional[int] = None) -> dict:
    """Le pide al modelo que calcule, a mano, todos los parámetros de la cadena \
    de mastering (compresor, EQ de 4 bandas, multibanda, estéreo, limiter, etc.) \
    en base al análisis del track — NO elige entre presets predefinidos.

    `platform_options` es una lista de claves de plataforma válidas. Si se pasan \
    `audio`/`sr` (el mismo array ya cargado que se usó para `analyze_audio`), se \
    corre además la Fase 4 (Optimización): un preview real se renderiza con los \
    parámetros decididos y, si el LUFS logrado no coincide con el objetivo, se \
    corrige el makeup gain e itera hasta converger.

    Devuelve siempre un dict con todos los parámetros validados y clampeados \
    a rango, más 'platform' y 'reasoning', aunque la IA falle o no esté \
    disponible (usa una heurística de respaldo que también calcula los \
    valores a partir del análisis, no de un preset).
    """
    if not analysis:
        raise ValueError(
            "Se necesita analizar el track antes de poder decidir el mastering automático."
        )

    client = _get_client()
    if client is None:
        logger.warning(f"Auto-mastering sin IA disponible ({get_unavailable_reason()}), usando heurística.")
        params = _fallback_custom_params(analysis)
        result = {
            **params, "platform": (platform_options[0] if platform_options else None),
            "reasoning": (
                "No se pudo consultar a la IA, así que se calcularon los parámetros con una "
                "heurística de respaldo en base al rango dinámico, loudness y balance espectral del track."
            ),
        }
        return _apply_optimization(result, audio, sr)

    float_field_names = [k for k in PARAM_RANGES if k not in DB_EXPOSED_FIELDS]
    float_field_names += [_db_field_name(k) for k in DB_EXPOSED_FIELDS]
    enum_fields_hint = "\n".join(
        f'- "{field}": string, obligatorio, uno de {", ".join(repr(v) for v in values)}.'
        for field, values in STRING_ENUM_FIELDS.items()
    )
    json_fields_hint = (
        "Devolvé SOLO un objeto JSON plano (sin markdown, sin texto extra) con estas claves:\n"
        f"- Como número (float), obligatorio en todos: {', '.join(float_field_names)}.\n"
        f"- Como booleano (true/false), obligatorio en todos: {', '.join(BOOL_PARAM_FIELDS)}.\n"
        f"{enum_fields_hint}\n"
        f'- "platform": string, una de estas opciones o null: {", ".join(platform_options) if platform_options else "(ninguna)"}.\n'
        '- "reasoning": string, tu razonamiento (Fases 1-3) en 3-6 oraciones.'
    )

    ranges_block = _param_ranges_text()
    platforms_block = ", ".join(platform_options) if platform_options else "(ninguna)"
    system_prompt = AUTO_MASTER_SYSTEM_PROMPT.format(
        ranges_block=ranges_block,
        platforms_block=platforms_block,
        audio_context=build_audio_context(analysis),
    ) + "\n\n" + json_fields_hint

    data = None
    try:
        contents = [{"role": "user", "parts": [
            {"text": "Calculá los parámetros de mastering para este track y devolvé solo el JSON."}
        ]}]
        # PRECISIÓN: esta es la llamada que calcula ~90 parámetros numéricos
        # interdependientes de toda la cadena — la tarea más compleja de todo
        # el asistente. Antes corría con thinking_budget=0 (pensamiento
        # apagado a propósito) y sin temperature (default de gemini-2.5-flash
        # = 1.0 en escala 0-2, bastante alta). Ambas cosas priorizaban
        # velocidad/costo por sobre precisión en la única llamada donde más
        # importa lo contrario:
        # - thinking_budget=-1 (dinámico): el modelo decide cuánto "pensar"
        #   según la complejidad real del track, en vez de responder de un
        #   tirón sin razonar la interdependencia entre etapas.
        # - temperature=0.3: mucha menos variabilidad corrida a corrida para
        #   una tarea que es esencialmente cálculo técnico, no creatividad.
        #   El campo "reasoning" (texto) sigue leyéndose natural con este
        #   valor; no hace falta temperature alta para que no suene robótico.
        # BUGFIX: maxOutputTokens en la API de Gemini es un presupuesto
        # COMPARTIDO entre los tokens de "pensamiento" (invisibles) y el
        # texto de salida real. Con thinking_budget=-1 (dinámico, sin techo)
        # el modelo podía gastar la mayor parte de los 4096 tokens pensando
        # y dejar el JSON de salida cortado a mitad de generación (JSON
        # inválido, "el asistente no anda" aunque el request nunca fallaba
        # — silenciosamente caía al heurístico de respaldo). Subido a 8192
        # para dejar margen real tanto al pensamiento dinámico como al JSON
        # completo (~90 campos + reasoning).
        raw = _gemini_generate_content(
            system_prompt, contents, max_output_tokens=8192,
            thinking_budget=-1, temperature=0.3,
        )
        data = _extract_json_object(raw) if raw else None
        if data is None and raw is not None:
            logger.error(f"JSON de auto-mastering ilegible. Raw: {raw[:400]!r}")
    except Exception as e:
        logger.error(f"No se pudo obtener/parsear la decisión de mastering de la IA: {e}")

    if not data:
        params = _fallback_custom_params(analysis)
        result = {
            **params, "platform": (platform_options[0] if platform_options else None),
            "reasoning": (
                "La IA no devolvió una respuesta válida, así que se calcularon los parámetros "
                "con una heurística de respaldo en base al análisis del track."
            ),
        }
        return _apply_optimization(result, audio, sr)

    result = {}
    for key, (lo, hi) in PARAM_RANGES.items():
        if key in DB_EXPOSED_FIELDS:
            continue
        try:
            clamped = _clamp(float(data.get(key, _NEUTRAL_PARAMS.get(key))), lo, hi)
        except (TypeError, ValueError):
            clamped = None
        result[key] = clamped if clamped is not None else _NEUTRAL_PARAMS.get(key)
        result[key] = round(result[key], 3)

    for key in DB_EXPOSED_FIELDS:
        linear_val = _resolve_db_exposed_param(key, data, default_linear=_NEUTRAL_PARAMS.get(key))
        result[key] = round(linear_val if linear_val is not None else _NEUTRAL_PARAMS.get(key), 4)

    for key in BOOL_PARAM_FIELDS:
        result[key] = bool(data.get(key, _NEUTRAL_PARAMS.get(key, False)))

    for field, valid_values in STRING_ENUM_FIELDS.items():
        v = data.get(field)
        result[field] = v if v in valid_values else _NEUTRAL_PARAMS.get(field, valid_values[0])

    platform = data.get("platform")
    result["platform"] = platform if platform in (platform_options or []) else None

    result["reasoning"] = str(data.get("reasoning") or "").strip() or (
        "El asistente calculó estos parámetros según el análisis técnico del track."
    )

    return _apply_optimization(result, audio, sr)


def _extract_json_object(raw: str) -> Optional[dict]:
    """Intenta rescatar un dict JSON de una respuesta de texto imperfecta:
    quita fences de markdown, recorta al primer '{'...último '}', y prueba
    arreglos comunes (comas colgantes, comillas simples) antes de rendirse.
    """
    import json
    import re

    if not raw:
        return None
    text = raw.strip()
    # Sacar fences tipo ```json ... ``` o ``` ... ```
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text).strip()

    candidates = [text]
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        candidates.append(match.group(0))

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except Exception:
            pass
        # Arreglo básico: comas colgantes antes de } o ]
        fixed = re.sub(r",\s*([}\]])", r"\1", candidate)
        try:
            return json.loads(fixed)
        except Exception:
            continue
    return None


