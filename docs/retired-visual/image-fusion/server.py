"""Run NVIDIA LocateAnything-3B and the existing local Qwen image model."""

from __future__ import annotations

import asyncio
import base64
import gc
import fcntl
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from typing import Any

import httpx
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from transformers import AutoModel, AutoProcessor, AutoTokenizer


app = FastAPI(title="LocateAnything plus Qwen image bridge", docs_url=None, redoc_url=None)

LOCATE_MODEL_ID = os.getenv("LOCATE_MODEL_ID", "nvidia/LocateAnything-3B")
HF_HOME = os.getenv("HF_HOME", "/root/.cache/huggingface")
QWEN_BASE_URL = os.getenv("QWEN_BASE_URL", "http://qwen-vision:11434").rstrip("/")
QWEN_MODEL_ID = os.getenv("QWEN_MODEL_ID", "qwen2.5vl:7b")
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024)))
MAX_NEW_TOKENS = int(os.getenv("MAX_NEW_TOKENS", "1024"))
QWEN_TIMEOUT_SECONDS = float(os.getenv("QWEN_TIMEOUT_SECONDS", "300"))
GPU_LOCK_PATH = Path(os.getenv("GPU_LOCK_PATH", "/run/ai-lock/gpu.lock"))
MODEL_DEVICE = os.getenv("MODEL_DEVICE", "cuda:0")
MODEL_DTYPE_NAME = os.getenv("MODEL_DTYPE", "float16").lower()


def model_dtype() -> torch.dtype:
    if MODEL_DTYPE_NAME in {"bf16", "bfloat16"}:
        return torch.bfloat16
    if MODEL_DTYPE_NAME in {"fp32", "float32"}:
        return torch.float32
    return torch.float16


def require_cuda() -> None:
    if not torch.cuda.is_available() or not MODEL_DEVICE.startswith("cuda"):
        raise RuntimeError(
            f"LocateAnything requires CUDA; available={torch.cuda.is_available()} device={MODEL_DEVICE}"
        )


def assert_model_on_cuda(model: Any) -> None:
    devices = {str(parameter.device) for parameter in model.parameters()}
    if not devices or any(not device.startswith("cuda") for device in devices):
        raise RuntimeError(
            f"LocateAnything refused CPU offload; model devices={sorted(devices)}"
        )


def model_devices(model: Any | None) -> list[str]:
    if model is None:
        return []
    return sorted({str(parameter.device) for parameter in model.parameters()})

_locator: Any | None = None
_tokenizer: Any | None = None
_processor: Any | None = None
_locator_lock = Lock()
_request_lock = asyncio.Lock()


@contextmanager
def gpu_lock():
    GPU_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with GPU_LOCK_PATH.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def get_locator() -> tuple[Any, Any, Any]:
    global _locator, _tokenizer, _processor
    if _locator is not None and _tokenizer is not None and _processor is not None:
        return _locator, _tokenizer, _processor

    with _locator_lock:
        if _locator is None or _tokenizer is None or _processor is None:
            require_cuda()
            _tokenizer = AutoTokenizer.from_pretrained(
                LOCATE_MODEL_ID, trust_remote_code=True, cache_dir=HF_HOME
            )
            _processor = AutoProcessor.from_pretrained(
                LOCATE_MODEL_ID, trust_remote_code=True, cache_dir=HF_HOME
            )
            _locator = AutoModel.from_pretrained(
                LOCATE_MODEL_ID,
                torch_dtype=model_dtype(),
                trust_remote_code=True,
                device_map={"": MODEL_DEVICE},
                low_cpu_mem_usage=True,
                cache_dir=HF_HOME,
            ).eval()
            assert_model_on_cuda(_locator)
    return _locator, _tokenizer, _processor


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": LOCATE_MODEL_ID,
        "locatorLoaded": _locator is not None,
        "qwen": QWEN_MODEL_ID,
        "cudaAvailable": torch.cuda.is_available(),
        "modelDevice": MODEL_DEVICE,
        "loadedDevices": model_devices(_locator),
    }


@app.get("/readyz")
def readyz() -> dict[str, Any]:
    if _locator is None:
        raise HTTPException(status_code=503, detail="LocateAnything-3B is not loaded yet")
    return {"status": "ready", "model": LOCATE_MODEL_ID, "qwen": QWEN_MODEL_ID}


async def save_upload(upload: UploadFile, destination: Path) -> int:
    total = 0
    with destination.open("wb") as output:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="image is too large")
            output.write(chunk)
    return total


def locate_image(path: Path, prompt: str, max_chars: int) -> str:
    with gpu_lock():
        model, tokenizer, processor = get_locator()
        response = inputs = images = videos = image = None
        try:
            image = Image.open(path).convert("RGB")
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": image},
                        {"type": "text", "text": prompt},
                    ],
                }
            ]
            text = processor.py_apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            images, videos = processor.process_vision_info(messages)
            inputs = processor(
                text=[text], images=images, videos=videos, return_tensors="pt"
            ).to(MODEL_DEVICE)
            if "pixel_values" in inputs and inputs["pixel_values"].is_floating_point():
                inputs["pixel_values"] = inputs["pixel_values"].to(model_dtype())
            with torch.inference_mode():
                response = model.generate(
                    pixel_values=inputs.get("pixel_values"),
                    input_ids=inputs["input_ids"],
                    attention_mask=inputs.get("attention_mask"),
                    image_grid_hws=inputs.get("image_grid_hws"),
                    tokenizer=tokenizer,
                    max_new_tokens=min(MAX_NEW_TOKENS, max_chars),
                    use_cache=True,
                    generation_mode="hybrid",
                    temperature=0.2,
                    do_sample=False,
                    repetition_penalty=1.1,
                    verbose=False,
                )
            answer = response[0] if isinstance(response, tuple) else response
            if isinstance(answer, (list, tuple)):
                answer = " ".join(str(item) for item in answer)
            return str(answer).strip()[:max_chars]
        finally:
            # Keep only one heavyweight vision model resident on the 16 GiB GPU.
            del response, inputs, images, videos, image
            del model, tokenizer, processor
            unload_locator()


def unload_locator() -> None:
    global _locator, _tokenizer, _processor
    _locator = None
    _tokenizer = None
    _processor = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def ask_qwen(path: Path, prompt: str, max_chars: int) -> str:
    image_b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    request = {
        "model": QWEN_MODEL_ID,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [image_b64],
            }
        ],
        "stream": False,
        # Avoid keeping a second large vision model resident after this call.
        "keep_alive": 0,
    }
    with gpu_lock(), httpx.Client(timeout=QWEN_TIMEOUT_SECONDS, trust_env=False) as client:
        response = client.post(f"{QWEN_BASE_URL}/api/chat", json=request)
        response.raise_for_status()
        payload = response.json()
    message = payload.get("message") or {}
    text = message.get("content", "")
    return str(text).strip()[:max_chars]


@app.post("/analyze-image")
async def analyze_image(
    image: UploadFile = File(...),
    prompt: str = Form("识别图片中的主要对象、场景、文字和关键细节。"),
    max_chars: int = Form(2000),
) -> dict[str, Any]:
    max_chars = max(200, min(max_chars, 4000))
    suffix = Path(image.filename or "image.jpg").suffix or ".jpg"
    with tempfile.TemporaryDirectory(prefix="locate-qwen-") as temp_dir:
        image_path = Path(temp_dir) / f"input{suffix}"
        await save_upload(image, image_path)

        locate_prompt = (
            "Locate all salient objects and text regions in this image. "
            "Return each label followed by its bounding box using "
            "<box> x1, y1, x2, y2 </box> coordinates. "
            "Include people, vehicles, signs, screens, and document text regions."
        )
        fusion_prompt = (
            f"{prompt}\n\n"
            "下面是专门的定位模型给出的目标位置结果。请把它作为辅助证据，"
            "逐项核对图像内容，并补充场景语义、可读文字和不确定项；不要臆造看不清的文字。\n"
        )

        async with _request_lock:
            try:
                localization = await asyncio.to_thread(
                    locate_image, image_path, locate_prompt, max_chars
                )
            except (OSError, RuntimeError, ValueError) as exc:
                localization = f"定位模型暂时失败：{exc}"
            try:
                understanding = await asyncio.to_thread(
                    ask_qwen, image_path, fusion_prompt + localization, max_chars
                )
            except (httpx.HTTPError, OSError, ValueError) as exc:
                understanding = f"千问图像识别暂时失败：{exc}"

    if understanding.startswith("千问图像识别暂时失败") and localization.startswith("定位模型暂时失败"):
        raise HTTPException(status_code=502, detail="both image models failed")

    text = (
        "定位模型（NVIDIA LocateAnything-3B）：\n"
        f"{localization}\n\n"
        "内容模型（本地 Qwen2.5-VL 7B）：\n"
        f"{understanding}"
    )
    return {
        "text": text[: max_chars * 2],
        "localization": localization,
        "understanding": understanding,
        "models": [LOCATE_MODEL_ID, QWEN_MODEL_ID],
    }
