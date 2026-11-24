#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="$repo_root/guest/kernel/firecracker-v1.17.0-microvm-kernel-ci-x86_64-6.1.config"
work_dir="${1:?usage: build-verified-6.1.167.sh WORK_DIR OUTPUT_VMLINUX}"
output="${2:?usage: build-verified-6.1.167.sh WORK_DIR OUTPUT_VMLINUX}"
tag=v6.1.167
tag_object=4a0e9ad8b501631cbb55d2efcb08710578cb23f5
source_commit=1989cd3d56e257c783ac75200496a2341b50599c
signer=647F28654894E3BD457199BE38DBBDC86092693E
config_sha256=153ca1b40f3312bfb40b7587b471ea548a915f98f480f0d0892a1537957a2147
archive_sha256=2818053c07976ba4ed5f44deb0f5dc7ae7b0975d7918c313d48d8fe7c4e598cb
tag_remote=https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git
tag_mirror=https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux.git
archive_url=https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.167.tar.xz
signature_url=https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.1.167.tar.sign

for command in git gpg make gcc sha256sum bison flex bc pahole curl tar xz; do
  command -v "$command" >/dev/null || { echo "missing build tool: $command" >&2; exit 1; }
done
printf '%s  %s\n' "$config_sha256" "$config" | sha256sum --check --status
grep -qx 'CONFIG_SECURITY_LANDLOCK=y' "$config"
grep -q '^CONFIG_LSM="landlock,' "$config"

mkdir -p "$work_dir"
work_dir="$(cd "$work_dir" && pwd)"
source="$work_dir/linux-6.1.167"
archive="$work_dir/linux-6.1.167.tar.xz"
archive_signature="$work_dir/linux-6.1.167.tar.sign"
tag_repository="$work_dir/signed-tag"
key_home="$work_dir/gnupg"
mkdir -p "$key_home"
chmod 700 "$key_home"
export GNUPGHOME="$key_home"
gpg --batch --locate-keys gregkh@kernel.org >/dev/null
actual_signer="$(gpg --batch --with-colons --fingerprint gregkh@kernel.org | awk -F: '$1 == "fpr" { print $10; exit }')"
test "$actual_signer" = "$signer" || { echo 'kernel signing fingerprint mismatch' >&2; exit 1; }

advertised_tag="$(git ls-remote --tags "$tag_remote" "refs/tags/$tag" | awk '{ print $1 }')"
test "$advertised_tag" = "$tag_object" || {
  echo 'kernel.org does not advertise the pinned tag object' >&2
  exit 1
}
if test ! -d "$tag_repository/.git"; then
  mkdir -p "$tag_repository"
  git -C "$tag_repository" init -q
fi
git -C "$tag_repository" fetch --depth=1 --filter=tree:0 "$tag_mirror" \
  "refs/tags/$tag:refs/tags/$tag"
test "$(git -C "$tag_repository" rev-parse "refs/tags/$tag")" = "$tag_object"
test "$(git -C "$tag_repository" rev-parse "refs/tags/$tag^{}")" = "$source_commit"
signature_status="$(git -C "$tag_repository" verify-tag --raw "$tag" 2>&1)"
printf '%s\n' "$signature_status"
printf '%s\n' "$signature_status" | grep -q "^\[GNUPG:\] VALIDSIG $signer " || {
  echo 'kernel tag was not signed by the pinned stable maintainer key' >&2
  exit 1
}
if test ! -s "$archive"; then
  curl -fLsS --retry 3 "$archive_url" -o "$archive"
fi
if test ! -s "$archive_signature"; then
  curl -fLsS --retry 3 "$signature_url" -o "$archive_signature"
fi
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
archive_status="$(xz -cd "$archive" | gpg --batch --status-fd 2 --verify "$archive_signature" - 2>&1)"
printf '%s\n' "$archive_status"
printf '%s\n' "$archive_status" | grep -q "^\[GNUPG:\] VALIDSIG $signer " || {
  echo 'kernel release archive signature did not match the pinned maintainer key' >&2
  exit 1
}
test ! -e "$source" || { echo 'build source already exists; choose a fresh work directory' >&2; exit 1; }
tar -xf "$archive" -C "$work_dir"
cp "$config" "$source/.config"
make -C "$source" olddefconfig
grep -qx 'CONFIG_SECURITY_LANDLOCK=y' "$source/.config"
grep -q '^CONFIG_LSM="landlock,' "$source/.config"
export KBUILD_BUILD_USER=caisson
export KBUILD_BUILD_HOST=caisson
export KBUILD_BUILD_TIMESTAMP='Wed Mar 25 10:05:25 UTC'
export KBUILD_BUILD_VERSION=1
export SOURCE_DATE_EPOCH=1774433015
make -C "$source" -j "${CAISSON_KERNEL_BUILD_JOBS:-2}" vmlinux
install -m 0644 "$source/vmlinux" "$output"
sha256sum "$output"
