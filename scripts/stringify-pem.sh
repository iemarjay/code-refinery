#!/usr/bin/env bash
#
# Converts a PKCS8 PEM file into a single-line string with literal \n.
# Suitable for .dev.vars or `wrangler secret put`.
#
# Usage: ./scripts/stringify-pem.sh path/to/private-key.pem
#
# Output can be pasted directly into .dev.vars:
#   GITHUB_PRIVATE_KEY="<output>"

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <pem-file>" >&2
  exit 1
fi

PEM_FILE="$1"

if [ ! -f "$PEM_FILE" ]; then
  echo "Error: File not found: $PEM_FILE" >&2
  exit 1
fi

# Replace newlines with literal \n
awk 'NR>1{printf "\\n"}{printf "%s",$0}' "$PEM_FILE"
echo
