# Stage 1: Build the React frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# Stage 2: Create the Python production runtime
FROM python:3.11-slim
WORKDIR /app

# Install ffmpeg, ffprobe, and system utilities
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

# Install FastAPI backend requirements
COPY web/backend/requirements.txt ./web/backend/requirements.txt
RUN pip install --no-cache-dir -r web/backend/requirements.txt

# Install yt-dlp optional package dependencies to ensure it works optimally
RUN pip install --no-cache-dir brotli certifi mutagen requests urllib3 websockets

# Copy the custom local yt_dlp module
COPY yt_dlp/ ./yt_dlp/

# Copy the backend source files
COPY web/backend/ ./web/backend/

# Copy built frontend assets from Stage 1 into the location expected by main.py
COPY --from=frontend-builder /app/dist/ ./web/dist/

# Set env settings
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

# Start server
CMD uvicorn web.backend.main:app --host 0.0.0.0 --port ${PORT}
