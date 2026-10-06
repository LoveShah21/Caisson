#!/usr/bin/env sh

# Download into a temporary sibling and publish only a complete transfer.
# HTTP errors such as a repository miss are returned immediately so callers
# can try an alternate repository. Transport failures, including curl 18
# (truncated response), are retried without retaining partial bytes.
download_with_retry() {
  source_url=$1
  destination=$2
  maximum_attempts=${3:-5}
  partial="${destination}.part"
  attempt=1

  while [ "$attempt" -le "$maximum_attempts" ]; do
    rm -f "$partial"
    if curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 15 --max-time 300 "$source_url" -o "$partial"; then
      mv "$partial" "$destination"
      return 0
    else
      status=$?
    fi
    rm -f "$partial"
    if [ "$status" -eq 22 ] || [ "$attempt" -eq "$maximum_attempts" ]; then
      return "$status"
    fi
    sleep "$attempt"
    attempt=$((attempt + 1))
  done
}
