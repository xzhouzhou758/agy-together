#!/bin/sh
# Build agy-scheduler.so for the eceasy/cli-proxy-api:v8.0.40 image (Debian 12, glibc 2.36, amd64).
# Usage: sh test/build.sh <src-dir-on-docker-host>
set -e
SRC=${1:-/opt/agy-build/src}
docker run --rm -v "$SRC":/src -v /opt/agy-build/gocache:/go/pkg -w /src golang:1.26-bookworm \
  sh -c 'go mod download && CGO_ENABLED=1 go build -buildmode=c-shared -trimpath -o /src/agy-scheduler.so . && rm -f /src/agy-scheduler.h'
ls -la "$SRC/agy-scheduler.so"
