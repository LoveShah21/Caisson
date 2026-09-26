#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
probe_dir="$root/m1-dev-probe"
output=${1:-"$root/rootfs/m1-dev-probe-rootfs.ext4"}
work=${TMPDIR:-/tmp}/caisson-m1-dev-probe-rootfs-$$

command -v go >/dev/null
command -v mkfs.ext4 >/dev/null
command -v debugfs >/dev/null

mkdir -p "$(dirname "$output")" "$work"
trap 'rm -rf "$work"' EXIT

(
  cd "$probe_dir"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$work/init" .
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$work/echo" ./echo
)

truncate -s 64M "$output"
mkfs.ext4 -q -F "$output"
debugfs -w -R "mkdir /bin" "$output" >/dev/null
debugfs -w -R "write $work/init /init" "$output" >/dev/null
debugfs -w -R "write $work/echo /bin/echo" "$output" >/dev/null
