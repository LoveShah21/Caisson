#!/usr/bin/env sh
set -eu

output=${1:-../rootfs/m1-dev-probe}
mkdir -p "$(dirname "$output")"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$output" .
