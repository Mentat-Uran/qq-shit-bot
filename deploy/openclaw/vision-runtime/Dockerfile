ARG BASE_IMAGE=vllm/vllm-openai:v0.26.0

FROM ${BASE_IMAGE} AS common

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MAX_JOBS=1

WORKDIR /app

# Keep the packages used by both media workers in one layer. The model
# runtimes remain separate because Mage-VL and LocateAnything require
# incompatible Transformers versions.
#
# Every package is exact-pinned to the version currently installed in the
# locally built images (see `pip freeze` inside qq-shit-bot-video-bridge /
# qq-shit-bot-image-fusion). Ranges would let a fresh PyPI release reach the
# GPU containers without review, which contradicts the exact-pin policy used
# in pyproject.toml. Bump the pins deliberately and rebuild + re-test the
# images when updating.
RUN pip install --no-cache-dir \
       accelerate==1.14.0 \
       fastapi==0.136.3 \
       numpy==2.2.6 \
       opencv-python-headless==5.0.0.93 \
       pillow==12.3.0 \
       python-multipart==0.0.32 \
       uvicorn[standard]==0.51.0

FROM common AS video

RUN pip install --no-cache-dir --no-build-isolation \
       "mamba-ssm==2.3.2.post1" \
    && pip install --no-cache-dir \
       "transformers==5.14.1"

COPY video-bridge/server.py /app/server.py

EXPOSE 8080
ENTRYPOINT ["uvicorn"]
CMD ["server:app", "--host", "0.0.0.0", "--port", "8080"]

FROM common AS image

RUN pip install --no-cache-dir \
       "transformers==4.57.1" \
       httpx==0.28.1 \
       decord==0.6.0 \
       lmdb==2.3.0 \
       peft==0.20.0

COPY image-fusion/server.py /app/server.py

EXPOSE 8080
ENTRYPOINT ["uvicorn"]
CMD ["server:app", "--host", "0.0.0.0", "--port", "8080"]
