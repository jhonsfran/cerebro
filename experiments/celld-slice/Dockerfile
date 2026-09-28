FROM golang:1.24.7-bookworm@sha256:b8bae5bd9ba9b1f89b635c91c24cc75cea335a16fb5076310f38566fc674b1ec AS minio-build
ADD --checksum=sha256:60cc56473acf8ea58d30d0ffa39123c0813fd196236826b390d442eeb8443813 https://api.github.com/repos/minio/minio/tarball/07c3a429bfed433e49018cb0f78a52145d4bedeb /tmp/minio.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1
RUN CGO_ENABLED=0 go build -trimpath -o /out/minio .

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS minio
COPY --from=minio-build /out/minio /usr/local/bin/minio
ENTRYPOINT ["minio"]

FROM ghcr.io/denoland/celld:0.6.0@sha256:e188a7f2bb0b8cec9fb04ee4c3d1ed7cca0ea0419519ae2a9ba36e5b6fe5161b AS celld

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS experiment
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=celld /etc/ssl/certs /etc/ssl/certs
WORKDIR /experiment
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --workspaces=false
ENV PATH="/experiment/node_modules/.bin:${PATH}"
COPY . .
RUN node scripts/patch-dependencies.mjs
CMD ["node", "scripts/check.mjs"]
