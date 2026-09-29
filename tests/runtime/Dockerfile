FROM ghcr.io/denoland/celld:0.6.0@sha256:e188a7f2bb0b8cec9fb04ee4c3d1ed7cca0ea0419519ae2a9ba36e5b6fe5161b AS celld-bin

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
COPY --from=celld-bin /usr/local/bin/celld /usr/local/bin/celld
COPY --from=celld-bin /etc/ssl/certs /etc/ssl/certs
WORKDIR /runtime
COPY experiments/celld-slice/package.json experiments/celld-slice/package-lock.json ./
RUN npm ci --ignore-scripts --workspaces=false
ENV PATH="/runtime/node_modules/.bin:${PATH}"
COPY experiments/celld-slice/scripts/patch-dependencies.mjs ./scripts/patch-dependencies.mjs
RUN node scripts/patch-dependencies.mjs
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/runtime ./packages/runtime
COPY experiments/celld-slice/fixtures/provider.ts ./fixtures/provider.ts
COPY tests/runtime ./tests/runtime
RUN mkdir -p node_modules/@cerebro && \
    ln -s ../../packages/contracts node_modules/@cerebro/contracts && \
    ln -s ../../packages/db node_modules/@cerebro/db
COPY tests/runtime/wrangler.jsonc ./wrangler.jsonc
