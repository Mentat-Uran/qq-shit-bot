ARG BASE_IMAGE=vllm/vllm-openai:latest
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MAX_JOBS=1

WORKDIR /app

# The vLLM image already contains CUDA and PyTorch. Mage-VL is loaded through
# Transformers because its custom architecture is not accepted by the vLLM
# version shipped in Docker Desktop at the time of setup.
RUN pip install --no-cache-dir --no-build-isolation \
       "mamba-ssm==2.3.2.post1" \
    && pip install --no-cache-dir \
       "transformers>=5.7,<6" \
       accelerate \
       fastapi \
       numpy \
       opencv-python-headless \
       pillow \
       python-multipart \
       uvicorn[standard]

COPY server.py .

EXPOSE 8080
ENTRYPOINT ["uvicorn"]
CMD ["server:app", "--host", "0.0.0.0", "--port", "8080"]
