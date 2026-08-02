ARG BASE_IMAGE=vllm/vllm-openai:latest
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# LocateAnything's published worker targets Transformers 4.57.1. This image
# is intentionally separate from the Mage-VL image, whose code needs a newer
# Transformers release.
RUN pip install --no-cache-dir \
       "transformers==4.57.1" \
       accelerate \
       fastapi \
       httpx \
       decord \
       lmdb \
       numpy \
       opencv-python-headless==4.11.0.86 \
       peft \
       pillow \
       python-multipart \
       uvicorn[standard]

COPY server.py .

EXPOSE 8080
ENTRYPOINT ["uvicorn"]
CMD ["server:app", "--host", "0.0.0.0", "--port", "8080"]
