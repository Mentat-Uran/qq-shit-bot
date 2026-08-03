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
RUN pip install --no-cache-dir \
       accelerate \
       fastapi \
       numpy \
       opencv-python-headless \
       pillow \
       python-multipart \
       uvicorn[standard]

FROM common AS video

RUN pip install --no-cache-dir --no-build-isolation \
       "mamba-ssm==2.3.2.post1" \
    && pip install --no-cache-dir \
       "transformers>=5.7,<6"

COPY video-bridge/server.py /app/server.py

EXPOSE 8080
ENTRYPOINT ["uvicorn"]
CMD ["server:app", "--host", "0.0.0.0", "--port", "8080"]

FROM common AS image

RUN pip install --no-cache-dir \
       "transformers==4.57.1" \
       httpx \
       decord \
       lmdb \
       peft

COPY image-fusion/server.py /app/server.py

EXPOSE 8080
ENTRYPOINT ["uvicorn"]
CMD ["server:app", "--host", "0.0.0.0", "--port", "8080"]
