# Same baseline for local builds and GitHub's native amd64/arm64 runners.
FROM ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config curl ca-certificates git python3 \
    libx11-dev libxcursor-dev libxrandr-dev libxi-dev libxinerama-dev \
    libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev \
    libgl1-mesa-dev libegl1-mesa-dev libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.98.1 \
    && rustup component add clippy rustfmt \
    && rm /tmp/rustup.sh
WORKDIR /work
