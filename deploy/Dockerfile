# syntax=docker/dockerfile:1
FROM golang:1.24.7-bookworm@sha256:b8bae5bd9ba9b1f89b635c91c24cc75cea335a16fb5076310f38566fc674b1ec AS minio-build
ADD --checksum=sha256:60cc56473acf8ea58d30d0ffa39123c0813fd196236826b390d442eeb8443813 https://api.github.com/repos/minio/minio/tarball/07c3a429bfed433e49018cb0f78a52145d4bedeb /tmp/minio.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/build-ca.pem; export SSL_CERT_FILE=/tmp/build-ca.pem; fi; \
    CGO_ENABLED=0 go build -trimpath -o /out/minio . && rm -f /tmp/build-ca.pem

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS minio
COPY --from=minio-build /out/minio /usr/local/bin/minio
COPY deploy/entrypoint.mjs /app/deploy/entrypoint.mjs
WORKDIR /app
ENTRYPOINT ["node", "deploy/entrypoint.mjs", "minio"]

FROM ghcr.io/denoland/celld:0.6.1@sha256:acb0bc2dca628f0dac7c6b43eea42615a79f4943f316f6df7c1da0b86d52150b AS celld-bin

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS fixture
WORKDIR /app
COPY tests/slice-1/provider.mjs ./tests/slice-1/provider.mjs
CMD ["node", "tests/slice-1/provider.mjs"]

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS app
COPY --from=celld-bin /usr/local/bin/celld /usr/local/bin/celld
COPY --from=celld-bin /etc/ssl/certs /etc/ssl/certs
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy
COPY tests/slice-1 ./tests/slice-1
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN node deploy/patch-dependencies.mjs
ARG VITE_SERVER_URL=http://localhost:18765
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
RUN pnpm build
ENV CEREBRO_SECRETS_DIR=/run/cerebro-secrets
