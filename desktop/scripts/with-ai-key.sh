#!/usr/bin/env bash
# Usage: scripts/with-ai-key.sh npm run dist:mac
# Reads the shared LiteLLM app key from the server into UBM_AI_KEY for this build only.
# The key is never echoed, written to disk, or committed.
set -euo pipefail
UBM_AI_KEY="$(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i "$HOME/.ssh/openmaus_vps" root@212.47.67.143 cat /root/litellm-keys/ubion-messenger.key 2>/dev/null | tr -d '\r\n')" || true
if [ -z "${UBM_AI_KEY:-}" ]; then echo "with-ai-key: could not read key — building with AI assist OFF" >&2; fi
export UBM_AI_KEY
export UBM_AI_BASE_URL="${UBM_AI_BASE_URL:-https://llm.ubion.global/v1}"
export UBM_AI_MODEL="${UBM_AI_MODEL:-ubm-todo}"
exec "$@"
