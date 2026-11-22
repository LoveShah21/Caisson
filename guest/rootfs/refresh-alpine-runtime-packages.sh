#!/usr/bin/env sh
set -eu

for command in apk sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s\n' "missing required command: $command" >&2
    exit 1
  }
done

work=${TMPDIR:-/tmp}/caisson-alpine-package-refresh-$$
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/packages"

cat > "$work/repositories" <<'EOF'
https://mirrors.aliyun.com/alpine/v3.21/main
https://mirrors.aliyun.com/alpine/v3.21/community
EOF

# apk verifies the signed repository indexes and package signatures before the
# resulting archives are hashed. This command is an explicit maintainer action;
# production builds consume only the checked-in output and never resolve live.
apk --repositories-file "$work/repositories" --no-cache update >/dev/null
apk --repositories-file "$work/repositories" --no-cache fetch --recursive \
  --output "$work/packages" busybox git jq nodejs python3 python3-pyc ripgrep >/dev/null

printf '%s\n' \
  '# Exact Alpine v3.21 x86_64 package closure for the M-3 agent-runtime tools.' \
  '# Format: package@version@sha256. The build derives archive names without' \
  '# resolving dependencies through a live package index.'

for archive in "$work"/packages/*.apk; do
  package_info=$(tar -xOf "$archive" .PKGINFO)
  package_name=$(printf '%s\n' "$package_info" | sed -n 's/^pkgname = //p')
  package_version=$(printf '%s\n' "$package_info" | sed -n 's/^pkgver = //p')
  package_sha256=$(sha256sum "$archive" | awk '{ print $1 }')
  printf '%s@%s@%s\n' "$package_name" "$package_version" "$package_sha256"
done | sort
