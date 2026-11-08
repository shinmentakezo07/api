FROM node:22-alpine

WORKDIR /app

# gateway is dependency-free plain Node — just copy the source
COPY index.js ./
COPY src ./src

# writable state (accounts.json, logs, .admin-key) lives here — mount a volume.
# DATA_DIR is the only one the app reads; PORT/HOST are read from the
# environment by src/config.js, so they are not baked in here.
ENV DATA_DIR=/app/data \
    HOST=0.0.0.0

# Health endpoint port follows $PORT (defaults to the app's own default).
ENV PORT=8787

# /app/data is volume-backed: create it owned by node so a fresh volume is
# writable without running the process as root.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# bind all interfaces inside the container; publish with -p / compose ports
EXPOSE 8787

# Probe the configured port, not a hardcoded one, so an overridden PORT does
# not report a healthy container as unhealthy (or vice versa).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "index.js"]
