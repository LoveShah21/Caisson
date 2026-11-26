#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:?usage: build-minimal-text-tools.sh OUTPUT}
work=${TMPDIR:-/tmp}/caisson-minimal-text-tools-$$
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/source" "$work/gnupg"
chmod 0700 "$work/gnupg"

version=1.37.0
source_hash=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
signer=C9E9416F76E610DBD09D040F47B70C55ACC9965B
# Both pins are independently published by docker-library/busybox at
# https://github.com/docker-library/busybox/blob/master/latest-1/musl/Dockerfile.builder

# This is the same checksum-locked Ubuntu build toolchain as the guest kernel.
python3 "$root/../kernel/check-toolchain.py"
for tool in bzip2 curl gcc gpg make sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'missing minimal text-tool build dependency: %s\n' "$tool" >&2
    exit 1
  }
done

archive="$work/busybox-$version.tar.bz2"
if [ -n "${CAISSON_BUSYBOX_SOURCE_CACHE:-}" ] && [ -f "$CAISSON_BUSYBOX_SOURCE_CACHE/busybox-$version.tar.bz2" ]; then
  cp "$CAISSON_BUSYBOX_SOURCE_CACHE/busybox-$version.tar.bz2" "$archive"
else
  curl -fsSL --retry 3 --max-time 120 -o "$archive" "https://busybox.net/downloads/busybox-$version.tar.bz2"
fi
printf '%s  %s\n' "$source_hash" "$archive" | sha256sum -c - >/dev/null
curl -fsSL --retry 3 --max-time 30 -o "$work/source.sig" "https://busybox.net/downloads/busybox-$version.tar.bz2.sig"
curl -fsSL --retry 3 --max-time 30 -o "$work/signing-key.gpg" 'https://busybox.net/~vda/vda_pubkey.gpg'
actual_signer=$(gpg --show-keys --with-colons "$work/signing-key.gpg" | awk -F: '$1 == "fpr" { print $10; exit }')
if [ "$actual_signer" != "$signer" ]; then
  printf 'unexpected BusyBox signing key: %s\n' "$actual_signer" >&2
  exit 1
fi
gpg --batch --homedir "$work/gnupg" --import "$work/signing-key.gpg" >/dev/null 2>&1
gpg --batch --homedir "$work/gnupg" --verify "$work/source.sig" "$archive" >/dev/null 2>&1

tar -xjf "$archive" -C "$work/source" --strip-components=1
(
  cd "$work/source"
  make allnoconfig >/dev/null
  for symbol in BUSYBOX STATIC CAT DIFF HEAD LS SORT TAIL UNIQ WC; do
    sed -i "s/^# CONFIG_$symbol is not set/CONFIG_$symbol=y/" .config
  done
  # BusyBox's allnoconfig still selects ash for the sh alias by default.
  sed -i 's/^CONFIG_SH_IS_ASH=y/# CONFIG_SH_IS_ASH is not set/;s/^# CONFIG_SH_IS_NONE is not set/CONFIG_SH_IS_NONE=y/' .config
  make oldconfig </dev/null >/dev/null
  make -j2 busybox >/dev/null
  ./busybox --list | sort > "$work/actual-applets"
)
if ! diff -u "$root/minimal-text-applets.lock" "$work/actual-applets"; then
  printf '%s\n' 'minimal BusyBox contains an unexpected applet' >&2
  exit 1
fi
if ldd "$work/source/busybox" 2>&1 | grep -q 'dynamically linked'; then
  printf '%s\n' 'minimal BusyBox was not statically linked' >&2
  exit 1
fi
install -m 0755 "$work/source/busybox" "$output"
printf 'PASS minimal text tools: %s\n' "$(tr '\n' ' ' < "$work/actual-applets")"
