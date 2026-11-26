#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:-"$root/caisson-agent-runtime-rootfs.ext4"}
build_tags=${CAISSON_AGENT_RUNTIME_BUILD_TAGS:-agent}
work=${TMPDIR:-/tmp}/caisson-agent-runtime-rootfs-$$
trap 'rm -rf "$work"' EXIT
# shellcheck source=download-with-retry.sh
. "$root/download-with-retry.sh"

download_alpine_package() {
  package_relative_path=$1
  package_destination=$2
  while IFS= read -r mirror_base; do
    case "$mirror_base" in
      ''|'#'*) continue ;;
      https://*) ;;
      *)
        printf '%s\n' "invalid Alpine mirror URL: $mirror_base" >&2
        return 1
        ;;
    esac
    if download_with_retry "$mirror_base/$package_relative_path" "$package_destination" 2; then
      return 0
    fi
  done < "$root/alpine-package-mirrors.lock"
  return 1
}

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
  elif ! download_alpine_package "v3.21/main/x86_64/$archive" "$package_path"; then
    if ! download_alpine_package "v3.21/community/x86_64/$archive" "$package_path"; then
      printf '%s\n' "locked Alpine package is unavailable from every pinned official mirror: $archive" >&2
      exit 1
    fi
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
rm -f "$work/staging/.post-deinstall" "$work/staging/.trigger"
mkdir -p "$work/staging/bin" "$work/staging/dev" "$work/staging/proc" "$work/staging/run" "$work/staging/tmp" "$work/staging/workspace" \
  "$work/staging/usr/bin" "$work/staging/usr/local/bin" "$work/staging/usr/libexec/caisson"
find "$work/staging/bin" -mindepth 1 -exec rm -rf {} +
find "$work/staging/usr/bin" -mindepth 1 \
  ! -name git ! -name jq ! -name node ! -name python3 ! -name python3.12 ! -name rg -exec rm -rf {} +
rm -rf "$work/staging/usr/lib/python3.12/ensurepip"
sh "$root/build-minimal-text-tools.sh" "$work/staging/usr/libexec/caisson/text-tools"
for tool in cat ls head tail wc sort uniq diff; do
  ln -sf /usr/libexec/caisson/text-tools "$work/staging/usr/local/bin/$tool"
done

# Git's HTTPS remote helper is the only permitted external executable in the
# fetch/clone exception. Remove every other helper, hook template, and script.
find "$work/staging/usr/libexec/git-core" -mindepth 1 -maxdepth 1 \
  ! -name git-remote-http ! -name git-remote-https -exec rm -rf {} +
test -f "$work/staging/usr/libexec/git-core/git-remote-http"
test "$(readlink "$work/staging/usr/libexec/git-core/git-remote-https")" = git-remote-http

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
# mkfs.ext4 -d preserves the unprivileged builder's uid. The runtime checks
# these executable search and helper paths are root-owned, so set their ext4
# inode ownership explicitly without requiring a privileged host build.
for trusted_path in /bin /usr/bin /usr/local/bin /usr/libexec/git-core /usr/libexec/git-core/git-remote-http; do
  debugfs -w -R "sif $trusted_path uid 0" "$output" >/dev/null
  debugfs -w -R "sif $trusted_path gid 0" "$output" >/dev/null
done
if [ "$(basename "$output")" = "caisson-agent-runtime-rootfs.ext4" ]; then
  node "$root/../../scripts/check-agent-runtime-rootfs-inventory.mjs" "$output"
fi
printf '%s\n' "PASS agent runtime rootfs: $output"
