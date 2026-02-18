FROM docker.io/cloudflare/sandbox:0.1.4

RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace

EXPOSE 3000
