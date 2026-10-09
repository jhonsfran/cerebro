# Test-only image: the fake model and connectors, and the writer of the test
# runtime.json. Production images never contain test code.
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
WORKDIR /fixture
COPY tests/slice-1/provider.mjs tests/slice-1/runtime-config.mjs ./
