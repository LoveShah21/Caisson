#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CAISSON_AGENT_RUNTIME_BUILD_TAGS=diagnostic exec "$root/build-agent-runtime-rootfs.sh" "${1:-$root/caisson-agent-runtime-diagnostic-rootfs.ext4}"
