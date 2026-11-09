#!/bin/sh
# Print a registry image digest, or nothing when the manifest does not exist.
# Authentication, networking and other errors must fail, not permit overwrites.
set -eu
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <image-reference>" >&2
  exit 1
fi
error_file=$(mktemp)
trap 'rm -f "$error_file"' EXIT HUP INT TERM
if manifest=$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>"$error_file"); then
  printf '%s\n' "$manifest" | jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))'
elif grep -Eq 'manifest unknown|MANIFEST_UNKNOWN|: not found$' "$error_file"; then
  exit 0
else
  cat "$error_file" >&2
  exit 1
fi
