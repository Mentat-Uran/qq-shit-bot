FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# The game engine and its prompt/state rules come from the published upstream
# package.  The HTTP adapter in service.py is the only local integration layer.
RUN pip install --no-cache-dir \
    'nonebot-plugin-ai-turtle-soup==1.0.9' \
    'fastapi>=0.115,<1' \
    'uvicorn>=0.34,<1'

WORKDIR /opt/qq-game
COPY service.py /opt/qq-game/service.py
COPY selection.py /opt/qq-game/selection.py
COPY sample_soups.json /opt/qq-game/sample_soups.json

USER 1000:1000
EXPOSE 18104
ENTRYPOINT ["python", "/opt/qq-game/service.py"]
