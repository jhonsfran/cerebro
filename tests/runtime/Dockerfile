FROM golang:1.24.7-bookworm@sha256:b8bae5bd9ba9b1f89b635c91c24cc75cea335a16fb5076310f38566fc674b1ec AS minio-build
ADD --checksum=sha256:60cc56473acf8ea58d30d0ffa39123c0813fd196236826b390d442eeb8443813 https://api.github.com/repos/minio/minio/tarball/07c3a429bfed433e49018cb0f78a52145d4bedeb /tmp/minio.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1
RUN CGO_ENABLED=0 go build -trimpath -o /out/minio .

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS minio
COPY --from=minio-build /out/minio /usr/local/bin/minio
ENTRYPOINT ["minio"]

FROM ghcr.io/denoland/celld:0.6.1@sha256:acb0bc2dca628f0dac7c6b43eea42615a79f4943f316f6df7c1da0b86d52150b AS celld-bin

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS dependencies
COPY --from=celld-bin /usr/local/bin/celld /usr/local/bin/celld
COPY --from=celld-bin /etc/ssl/certs /etc/ssl/certs
WORKDIR /runtime
COPY tests/runtime/package.json tests/runtime/package-lock.json ./
RUN npm ci --ignore-scripts --workspaces=false --legacy-peer-deps
ENV PATH="/runtime/node_modules/.bin:${PATH}"
COPY tests/runtime/scripts/patch-dependencies.mjs ./scripts/patch-dependencies.mjs
RUN node scripts/patch-dependencies.mjs
FROM dependencies AS app
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/runtime ./packages/runtime
COPY packages/tools ./packages/tools
COPY tests/runtime ./tests/runtime
COPY tests/slice-1/provider.mjs ./tests/slice-1/provider.mjs
RUN mkdir -p node_modules/@cerebro && \
    ln -s ../../packages/contracts node_modules/@cerebro/contracts && \
    ln -s ../../packages/db node_modules/@cerebro/db
COPY tests/runtime/wrangler.jsonc ./wrangler.jsonc
