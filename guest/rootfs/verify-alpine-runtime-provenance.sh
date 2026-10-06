#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=alpine-3.21.6.lock
. "$root/alpine-3.21.6.lock"
# shellcheck source=download-with-retry.sh
. "$root/download-with-retry.sh"

for command in curl gpg sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s\n' "missing required command: $command" >&2
    exit 1
  }
done

work=${CAISSON_ALPINE_PROVENANCE_DIR:-${TMPDIR:-/tmp}/caisson-alpine-provenance-$$}
if [ -z "${CAISSON_ALPINE_PROVENANCE_DIR:-}" ]; then
  trap 'rm -rf "$work"' EXIT
fi
mkdir -p "$work"

download_with_retry "$ALPINE_RELEASE_KEY_URL" "$work/ncopa.asc"
gpg --batch --no-default-keyring --keyring "$work/keyring.gpg" --import "$work/ncopa.asc" >/dev/null 2>&1
actual_fingerprint=$(gpg --batch --no-default-keyring --keyring "$work/keyring.gpg" --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10; exit }')
if [ "$actual_fingerprint" != "$ALPINE_RELEASE_KEY_FINGERPRINT" ]; then
  printf '%s\n' "Alpine release key fingerprint mismatch: $actual_fingerprint" >&2
  exit 1
fi

download_with_retry "$ALPINE_RELEASE_URL" "$work/minirootfs.tar.gz"
download_with_retry "$ALPINE_RELEASE_SIGNATURE_URL" "$work/minirootfs.tar.gz.asc"
gpg --batch --no-default-keyring --keyring "$work/keyring.gpg" --verify "$work/minirootfs.tar.gz.asc" "$work/minirootfs.tar.gz"
actual_sha256=$(sha256sum "$work/minirootfs.tar.gz" | awk '{ print $1 }')
if [ "$actual_sha256" != "$ALPINE_RELEASE_SHA256" ]; then
  printf '%s\n' "Alpine minirootfs SHA-256 mismatch: $actual_sha256" >&2
  exit 1
fi

printf '%s\n' "PASS Alpine $ALPINE_VERSION provenance: $actual_fingerprint $actual_sha256"
