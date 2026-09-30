#!/usr/bin/env sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CAISSON_RUNTIME_BUILD_TAGS=diagnostic exec "$root/build-runtime-rootfs.sh" "${1:-$root/caisson-runtime-diagnostic-rootfs.ext4}"
