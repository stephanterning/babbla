FROM node:24-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY LICENSE ./
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

COPY *.js ./
COPY stats ./stats
COPY public ./public

# Build stamp baked into the image (no .git/git binary at runtime). Passed as
# build args from CI; the server turns these into the UI's version string.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]
