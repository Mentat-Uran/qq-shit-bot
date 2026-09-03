FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# The turtle-soup engine and its prompt/state rules come from the published
# upstream package.  China-idiom supplies the large, dependency-free Chinese
# idiom catalog for the text games.  Both versions are pinned; service.py is
# the only local QQ integration layer.
RUN pip install --no-cache-dir \
    'nonebot-plugin-ai-turtle-soup==1.0.9' \
    'china-idiom @ https://github.com/sfyc23/China-idiom/archive/78606b0294a22e798633c4469a4009b78ad60f26.tar.gz' \
    'fastapi>=0.115,<1' \
    'uvicorn>=0.34,<1'

WORKDIR /opt/qq-game
COPY service.py /opt/qq-game/service.py
COPY chat_games.py /opt/qq-game/chat_games.py
COPY selection.py /opt/qq-game/selection.py
COPY sample_soups.json /opt/qq-game/sample_soups.json

USER 1000:1000
EXPOSE 18104
ENTRYPOINT ["python", "/opt/qq-game/service.py"]
