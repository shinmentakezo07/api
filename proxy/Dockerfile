FROM node:22-alpine

WORKDIR /app

# gateway is dependency-free plain Node — just copy the source
COPY index.js ./
COPY src ./src

# writable state (accounts.json, logs, .admin-key) lives here — mount a volume
ENV DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    NODE_ENV=production

RUN mkdir -p /app/data

# bind all interfaces inside the container; publish with -p / compose ports
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null 2>&1 || exit 1

CMD ["node", "index.js"]
