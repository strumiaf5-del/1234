# Instalación en Ubuntu con Python 3.13+

## 1. Instalar Python 3.13 (si tu Ubuntu no lo trae de fábrica)
```bash
sudo apt update
sudo apt install -y python3.13 python3.13-venv ffmpeg
```
`ffmpeg` es necesario porque `pydub` lo usa por debajo para leer/escribir mp3, ogg, etc.

## 2. Crear entorno virtual
```bash
cd backend
python3.13 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
```

## 3. Instalar dependencias
```bash
pip install -r requirements.txt
```
Esto va a bajar `torch` (varios cientos de MB, es normal que tarde). Si tenés GPU
NVIDIA y querés usar CUDA en vez de CPU, instalá torch con el índice de CUDA
correspondiente ANTES de correr `pip install -r requirements.txt` (ver
https://pytorch.org/get-started/locally/), así no te pisa la versión CPU.

## 4. Configurar variables de entorno
```bash
cp .env.example .env   # si no existe .env.example, copiá el .env que ya tenés
```
Completá `GEMINI_API_KEY` con tu clave (regenerá la que estaba en el zip original,
ya quedó expuesta).

## 5. Correr el backend
```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```
(ajustá `app:app` si el objeto FastAPI se llama distinto adentro de `app.py`)

## Fix aplicado: rutas duplicadas en app.py (no relacionado a Python 3.13)
`app.py` incluía 3 routers (`routes.py`, `routers_mastering.py`, `routers_ai.py`)
que redefinían los mismos endpoints que ya estaban en `app.py` (`/master`,
`/analyze`, `/stems/separate`, etc.), pero con versiones más simples — por
ejemplo, el `/master` de `routers_mastering.py` solo aceptaba
`output_format`/`output_bit_depth` y ELIMINABA silenciosamente todos los demás
parámetros (compresor, EQ, multibanda, saturación, etc.) porque FastAPI usa
la primera ruta registrada que matchea, y esa se registraba antes que la
versión completa de `app.py`.

Se sacaron los 3 `app.include_router(...)` de `app.py` para que las
implementaciones completas (las que sí soportan todos los parámetros) sean
las que responden. `routes.py`, `routers_mastering.py` y `routers_ai.py`
quedaron en el repo pero sin usarse — podés borrarlos si no los necesitás
para nada más.

## Notas de la migración (Windows 7 / Py3.8 → Ubuntu / Py3.13+)
- `demucs` (Meta) fue reemplazado por `demucs-infer`, un fork mantenido y
  compatible con PyTorch 2.x. Mismo comportamiento, solo cambió el nombre del
  paquete/import (`demucs_infer.*` en vez de `demucs.*`).
- `torch`/`torchaudio` ya no están pineados a 1.13.1 (eso era un piso viejo por
  Windows 7); ahora se instala la versión moderna, que sí tiene wheels para
  Python 3.13.
- Se agregó `audioop-lts`, porque Python 3.13 sacó el módulo `audioop` de la
  librería estándar y `pydub` lo necesita para funcionar.
- El resto del código no tenía nada específico de Windows ni módulos
  eliminados de Python, así que no requirió cambios.
