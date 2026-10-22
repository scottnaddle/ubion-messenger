#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export DAOU_PORT="${DAOU_PORT:-8787}"
export DAOU_BIND="${DAOU_BIND:-127.0.0.1}"
export DAOU_DATA="${DAOU_DATA:-$HOME/.daou-app}"
mkdir -p "$DAOU_DATA"

if [[ ! -d .venv ]]; then
  uv venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
uv pip install -q fastapi "uvicorn[standard]" httpx websockets

if [[ ! -f frontend/dist/index.html ]]; then
  echo "WARN: frontend/dist missing — open /api/health only until UI is built."
fi

export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
echo "Daou MVP → http://${DAOU_BIND}:${DAOU_PORT}/"
exec python -m uvicorn backend.app.main:app --host "$DAOU_BIND" --port "$DAOU_PORT" --log-level info
