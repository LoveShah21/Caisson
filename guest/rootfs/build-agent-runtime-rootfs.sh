#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:-"$root/caisson-agent-runtime-rootfs.ext4"}
build_tags=${CAISSON_AGENT_RUNTIME_BUILD_TAGS:-}
work=${TMPDIR:-/tmp}/caisson-agent-runtime-rootfs-$$
trap 'rm -rf "$work"' EXIT

for command in curl go mkfs.ext4 debugfs grep sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s\n' "missing required command: $command" >&2
    exit 1
  }
done

mkdir -p "$work/provenance" "$work/packages" "$work/staging" "$(dirname "$output")"
CAISSON_ALPINE_PROVENANCE_DIR="$work/provenance" "$root/verify-alpine-runtime-provenance.sh"
tar -xzf "$work/provenance/minirootfs.tar.gz" -C "$work/staging"

while IFS='@' read -r package_name package_version expected_sha256; do
  case "$package_name" in ''|'#'*) continue ;; esac
  archive="${package_name}-${package_version}.apk"
  case "$package_name" in *[!a-z0-9_+-]* | '')
    printf '%s\n' "invalid package name in lock: $package_name" >&2
    exit 1
    ;;
  esac
  case "$package_version" in *[!A-Za-z0-9._+-]* | '')
    printf '%s\n' "invalid package version in lock: $package_version" >&2
    exit 1
    ;;
  esac
  if [ "${#expected_sha256}" -ne 64 ] || ! printf '%s' "$expected_sha256" | grep -Eq '^[0-9a-f]{64}$'; then
    printf '%s\n' "invalid package SHA-256 in lock: $archive" >&2
    exit 1
  fi
  package_path="$work/packages/$archive"
  if [ -n "${CAISSON_ALPINE_PACKAGE_CACHE:-}" ] && [ -f "$CAISSON_ALPINE_PACKAGE_CACHE/$archive" ]; then
    cp "$CAISSON_ALPINE_PACKAGE_CACHE/$archive" "$package_path"
  elif ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64/$archive" -o "$package_path"; then
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "https://dl-cdn.alpinelinux.org/alpine/v3.21/community/x86_64/$archive" -o "$package_path"
  fi
  actual_sha256=$(sha256sum "$package_path" | awk '{ print $1 }')
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    printf '%s\n' "Alpine package SHA-256 mismatch for $archive: $actual_sha256" >&2
    exit 1
  fi
  tar --warning=no-unknown-keyword -xzf "$package_path" -C "$work/staging" \
    --exclude=.PKGINFO --exclude='.SIGN.*' --exclude=.post-install --exclude=.post-upgrade
done < "$root/alpine-runtime-packages.lock"

(cd "$root/../runtime" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -tags "$build_tags" -ldflags='-s -w' -o "$work/init" .)
install -m 0755 "$work/init" "$work/staging/init"

# The verified minirootfs is only a bootstrap layer. Remove its generic shell,
# package manager, network clients, and init surface after applying the locked
# tool closure. The tool runtime receives only explicit allowlisted entrypoints.
rm -rf "$work/staging/etc" "$work/staging/home" "$work/staging/media" "$work/staging/mnt" \
  "$work/staging/opt" "$work/staging/root" "$work/staging/run" "$work/staging/sbin" \
  "$work/staging/srv" "$work/staging/sys" "$work/staging/var" "$work/staging/lib/apk" \
  "$work/staging/usr/include" "$work/staging/usr/share"
mkdir -p "$work/staging/bin" "$work/staging/dev" "$work/staging/proc" "$work/staging/tmp" \
  "$work/staging/usr/bin" "$work/staging/usr/local/bin"
find "$work/staging/bin" -mindepth 1 ! -name busybox -exec rm -rf {} +
find "$work/staging/usr/bin" -mindepth 1 \
  ! -name git ! -name jq ! -name node ! -name python3 ! -name python3.12 ! -name rg -exec rm -rf {} +
rm -rf "$work/staging/usr/lib/python3.12/ensurepip"
for tool in cat ls head tail wc sort uniq diff; do
  ln -sf /bin/busybox "$work/staging/usr/local/bin/$tool"
done

# Unprivileged extraction cannot create device nodes. The guest needs only
# these static nodes; no devtmpfs mount is needed on the read-only rootfs.
rm -f "$work/staging/dev/null" "$work/staging/dev/random" "$work/staging/dev/urandom"

size_kib=$(du -sk "$work/staging" | awk '{ print $1 }')
size_mib=$((size_kib / 1024 + 96))
truncate -s "${size_mib}M" "$output"
mkfs.ext4 -q -F -d "$work/staging" "$output"
printf '%s\n' \
  'cd /dev' \
  'mknod null c 1 3' \
  'mknod random c 1 8' \
  'mknod urandom c 1 9' | debugfs -w "$output" >/dev/null
debugfs -w -R 'sif /init mode 0100755' "$output" >/dev/null
debugfs -w -R 'sif /dev/null mode 020666' "$output" >/dev/null
debugfs -w -R 'sif /dev/random mode 020666' "$output" >/dev/null
debugfs -w -R 'sif /dev/urandom mode 020666' "$output" >/dev/null
if [ "$(basename "$output")" = "caisson-agent-runtime-rootfs.ext4" ]; then
  node "$root/../../scripts/check-agent-runtime-rootfs-inventory.mjs" "$output"
fi
printf '%s\n' "PASS agent runtime rootfs: $output"
