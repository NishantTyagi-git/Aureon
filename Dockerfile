# Aureon — production image. Builds the app with the bundled MCX seed data; the database is created
# and filled on first start. Works on Render, Railway, Fly.io, Google Cloud Run, or any Docker host.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AUREON_HOST=0.0.0.0 \
    AUREON_READ_ONLY=true

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
# Build the database from data/seed and precompute every read-only page answer, once, at build time.
RUN python run.py prebuild
RUN useradd --create-home aureon && chown -R aureon /app
USER aureon

EXPOSE 8000
# The platform's PORT variable is honoured automatically (see backend/aureon/config.py).
CMD ["python", "run.py", "serve"]
