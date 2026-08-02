"""Local Transformers bridge for Microsoft Mage-VL video understanding."""

from __future__ import annotations

import asyncio
import gc
import fcntl
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from typing import Any

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from transformers import AutoModelForCausalLM, AutoProcessor


app = FastAPI(title="Mage-VL video bridge", docs_url=None, redoc_url=None)

MODEL_ID = os.getenv("MODEL_ID", "microsoft/Mage-VL")
HF_HOME = os.getenv("HF_HOME", "/root/.cache/huggingface")
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
DEFAULT_NUM_FRAMES = int(os.getenv("DEFAULT_NUM_FRAMES", "16"))
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "512"))
SEGMENT_SECONDS = float(os.getenv("SEGMENT_SECONDS", "60"))
MAX_SEGMENTS = int(os.getenv("MAX_SEGMENTS", "12"))
GPU_LOCK_PATH = Path(os.getenv("GPU_LOCK_PATH", "/run/ai-lock/gpu.lock"))

_model: Any | None = None
_processor: Any | None = None
_model_lock = Lock()


@contextmanager
def gpu_lock():
    GPU_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with GPU_LOCK_PATH.open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def model_device(model: Any) -> torch.device:
    try:
        return model.device
    except AttributeError:
        return next(model.parameters()).device


def get_model() -> tuple[Any, Any]:
    global _model, _processor
    if _model is not None and _processor is not None:
        return _model, _processor

    with _model_lock:
        if _model is None or _processor is None:
            _processor = AutoProcessor.from_pretrained(
                MODEL_ID, trust_remote_code=True, cache_dir=HF_HOME
            )
            _model = AutoModelForCausalLM.from_pretrained(
                MODEL_ID,
                trust_remote_code=True,
                torch_dtype="auto",
                device_map="auto",
                cache_dir=HF_HOME,
            ).eval()
    return _model, _processor


def unload_model() -> None:
    global _model, _processor
    _model = None
    _processor = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"status": "ok", "model": MODEL_ID, "modelLoaded": _model is not None}


@app.get("/readyz")
def readyz() -> dict[str, Any]:
    if _model is None or _processor is None:
        raise HTTPException(status_code=503, detail="Mage-VL is not loaded yet")
    return {"status": "ready", "model": MODEL_ID}


async def save_upload(upload: UploadFile, destination: Path) -> int:
    total = 0
    with destination.open("wb") as output:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="video is too large")
            output.write(chunk)
    return total


def sample_frames(
    path: Path, start_frame: int, end_frame: int, requested: int
) -> list[Image.Image]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise ValueError("could not open video")

    try:
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if frame_count <= 0 or end_frame <= start_frame:
            raise ValueError("video has no readable frames")
        start_frame = max(0, min(start_frame, frame_count - 1))
        end_frame = max(start_frame + 1, min(end_frame, frame_count))
        count = max(1, min(requested, end_frame - start_frame))
        indices = np.linspace(start_frame, end_frame - 1, count, dtype=int).tolist()
        frames: list[Image.Image] = []
        for index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, frame = capture.read()
            if ok:
                frames.append(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
        if not frames:
            raise ValueError("could not decode video frames")
        return frames
    finally:
        capture.release()


def move_inputs(inputs: Any, model: Any) -> dict[str, Any]:
    device = model_device(model)
    result: dict[str, Any] = {}
    for key, value in inputs.items():
        if not hasattr(value, "to"):
            result[key] = value
            continue
        value = value.to(device)
        if key == "pixel_values" and value.is_floating_point():
            value = value.to(model.dtype)
        result[key] = value
    return result


def analyze_frames(
    model: Any, processor: Any, frames: list[Image.Image], prompt: str, max_chars: int
) -> str:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "video"},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = processor(
        text=[text], videos=[frames], return_tensors="pt", padding=True
    )
    inputs = move_inputs(inputs, model)
    with torch.inference_mode():
        output = model.generate(
            **inputs, max_new_tokens=min(MAX_NEW_TOKENS, max_chars), do_sample=False
        )
    answer = processor.tokenizer.decode(
        output[0, inputs["input_ids"].shape[1] :], skip_special_tokens=True
    )
    answer = answer.strip()
    if answer.lower() in {"none of the choices provided", "none of the choices provided."}:
        return ""
    return answer[:max_chars]


def analyze_video(path: Path, prompt: str, num_frames: int, max_chars: int) -> str:
    with gpu_lock():
        model, processor = get_model()
        capture = cv2.VideoCapture(str(path))
        if not capture.isOpened():
            raise ValueError("could not open video")
        try:
            frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = float(capture.get(cv2.CAP_PROP_FPS)) or 25.0
        finally:
            capture.release()
        if frame_count <= 0:
            raise ValueError("video has no readable frames")

        duration = frame_count / fps
        segment_count = max(1, min(MAX_SEGMENTS, int(np.ceil(duration / SEGMENT_SECONDS))))
        actual_segment_seconds = duration / segment_count
        per_segment_chars = max(400, min(1600, max_chars // segment_count + 300))
        results: list[str] = []
        try:
            for segment_index in range(segment_count):
                start_seconds = segment_index * actual_segment_seconds
                end_seconds = min(duration, (segment_index + 1) * actual_segment_seconds)
                start_frame = int(start_seconds * fps)
                end_frame = max(start_frame + 1, int(end_seconds * fps))
                frames = sample_frames(path, start_frame, end_frame, num_frames)
                # Keep segment numbering in the wrapper output instead of the
                # model prompt. Mage-VL can otherwise echo the metadata on
                # later segments instead of describing the frames.
                segment_prompt = (
                    f"{prompt.strip()}\n"
                    "Describe only what is visibly present in this segment. "
                    "Do not repeat the instruction or segment metadata."
                )
                result = analyze_frames(
                    model, processor, frames, segment_prompt, per_segment_chars
                )
                if not result:
                    raise ValueError(
                        f"Mage-VL returned no usable answer for segment {segment_index + 1}"
                    )
                results.append(
                    f"[片段 {segment_index + 1} | {start_seconds:.1f}-{end_seconds:.1f}s]\n{result}"
                )
        finally:
            # The shared lock is held until the model is released, so image and
            # video requests cannot create two resident GPU models at once.
            unload_model()

    return "Mage-VL 分段视频分析（请由主语言模型汇总）：\n" + "\n\n".join(results)


@app.post("/analyze")
async def analyze(
    video: UploadFile = File(...),
    prompt: str = Form("Describe the video, including the main events and their order."),
    max_chars: int = Form(2000),
    num_frames: int = Form(DEFAULT_NUM_FRAMES),
) -> dict[str, Any]:
    max_chars = max(100, min(max_chars, 4000))
    num_frames = max(4, min(num_frames, 32))

    suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
    with tempfile.TemporaryDirectory(prefix="mage-video-") as temp_dir:
        video_path = Path(temp_dir) / f"input{suffix}"
        await save_upload(video, video_path)
        try:
            text = await asyncio.to_thread(
                analyze_video, video_path, prompt, num_frames, max_chars
            )
        except (OSError, ValueError, RuntimeError) as exc:
            raise HTTPException(status_code=502, detail=f"Mage-VL request failed: {exc}") from exc

    return {"text": text, "model": MODEL_ID, "frames": num_frames}
