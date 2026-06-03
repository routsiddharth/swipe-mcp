# Backend container — the FastAPI mock (mock_backend) + its /llm OpenRouter proxy.
# Built for Fly.io (see fly.toml) but works on any Docker host (Render, Railway,
# Cloud Run). The OpenRouter key is NOT baked in — it's read from the env at
# runtime (e.g. `fly secrets set OPENROUTER_API_KEY=...`).
FROM python:3.12-slim
WORKDIR /app

# Install deps first so the layer caches across code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Only the runtime code + spec. .dockerignore keeps .env, .venv, tests, etc. out.
COPY mock_backend ./mock_backend
COPY spec ./spec

# Auth is off by default (the mock serves only fake seed data). To mirror the
# real API's bearer-auth flow, set MOCK_REQUIRE_AUTH=true (+ optional
# MOCK_API_TOKEN) as a runtime env/secret.
ENV MOCK_HOST=0.0.0.0 MOCK_PORT=8000
EXPOSE 8000
CMD ["uvicorn", "mock_backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
