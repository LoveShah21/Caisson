#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output=${1:-"$root/rootfs/caisson-runtime-rootfs.ext4"}
build_tags=${CAISSON_RUNTIME_BUILD_TAGS:-}
work=${TMPDIR:-/tmp}/caisson-runtime-rootfs-$$
trap 'rm -rf "$work"' EXIT
command -v go >/dev/null; command -v mkfs.ext4 >/dev/null; command -v debugfs >/dev/null
mkdir -p "$(dirname "$output")" "$work"
(cd "$root/runtime" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -tags "$build_tags" -ldflags='-s -w' -o "$work/init" .)
truncate -s 32M "$output"; mkfs.ext4 -q -F "$output"
debugfs -w -R "mkdir /dev" "$output" >/dev/null
debugfs -w -R "mkdir /proc" "$output" >/dev/null
debugfs -w -R "mknod /dev/null c 1 3" "$output" >/dev/null
debugfs -w -R "mknod /dev/random c 1 8" "$output" >/dev/null
debugfs -w -R "mknod /dev/urandom c 1 9" "$output" >/dev/null
debugfs -w -R "write $work/init /init" "$output" >/dev/null
debugfs -w -R "sif /init mode 0100755" "$output" >/dev/null
debugfs -w -R "sif /dev/null mode 020666" "$output" >/dev/null
debugfs -w -R "sif /dev/random mode 020666" "$output" >/dev/null
debugfs -w -R "sif /dev/urandom mode 020666" "$output" >/dev/null
debugfs -R 'stat /init' "$output" | grep -q 'Mode:.*0100755'
if [ "$(basename "$output")" = "caisson-runtime-rootfs.ext4" ]; then
  node "$root/../scripts/check-runtime-rootfs-inventory.mjs" "$output"
fi
