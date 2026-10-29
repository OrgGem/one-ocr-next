FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ENV NODE_ENV=production ONNXRUNTIME_NODE_INSTALL=skip
WORKDIR /app
LABEL org.opencontainers.image.title="One OCR Next" \
      org.opencontainers.image.source="https://github.com/OrgGem/one-ocr-next" \
      org.opencontainers.image.description="Linux native OCR API with bundled OneOCR model"
COPY package.json package-lock.json ./
COPY tools/prune-runtime.mjs ./tools/prune-runtime.mjs
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --prefer-offline --no-audit --no-fund && node tools/prune-runtime.mjs
COPY src ./src
COPY tools/prepare-models.mjs ./tools/prepare-models.mjs
COPY docs/openapi.json ./docs/openapi.json
COPY models/README.md ./models/README.md
COPY models/oneocr.onemodel ./models/oneocr.onemodel
USER node
ENV ONEOCR_MODEL_PATH=/app/models/oneocr.onemodel ONEOCR_HOST=0.0.0.0 ONEOCR_PORT=8001
EXPOSE 8001
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
