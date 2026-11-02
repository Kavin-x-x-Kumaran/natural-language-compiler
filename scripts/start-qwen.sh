#!/usr/bin/env bash
set -euo pipefail

# llama.cpp project directory (override: LLAMA_DIR=/some/path ./scripts/start-qwen.sh)
if [ -n "${LLAMA_DIR:-}" ]; then
  LLAMA_DIR="$LLAMA_DIR"
elif [ -d /c/llama.cpp ]; then
  LLAMA_DIR=/c/llama.cpp
elif [ -d /mnt/c/llama.cpp ]; then
  LLAMA_DIR=/mnt/c/llama.cpp
else
  LLAMA_DIR="$HOME/llama.cpp"
fi

# Qwen model
MODEL="${LLAMA_HF_MODEL:-Qwen/Qwen3-4B-GGUF:Q4_K_M}"

# Colors
RED=$'\033[31m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

# Locate the llama-server executable
if [ -n "${LLAMA_SERVER:-}" ]; then
  SERVER="$LLAMA_SERVER"
  if [ ! -x "$SERVER" ]; then
    echo "${RED}ERROR: LLAMA_SERVER is not executable:${RESET}"
    echo "$SERVER"
    exit 1
  fi
elif [ -x "$LLAMA_DIR/build/bin/llama-server" ]; then
  SERVER="$LLAMA_DIR/build/bin/llama-server"
elif [ -x "$LLAMA_DIR/build/bin/Release/llama-server" ]; then
  SERVER="$LLAMA_DIR/build/bin/Release/llama-server"
elif [ -x "$LLAMA_DIR/build/bin/llama-server.exe" ]; then
  SERVER="$LLAMA_DIR/build/bin/llama-server.exe"
elif [ -x "$LLAMA_DIR/build/bin/Release/llama-server.exe" ]; then
  SERVER="$LLAMA_DIR/build/bin/Release/llama-server.exe"
elif [ -x "$LLAMA_DIR/llama-server.exe" ]; then
  SERVER="$LLAMA_DIR/llama-server.exe"
elif command -v llama-server >/dev/null 2>&1; then
  # e.g. installed with `brew install llama.cpp`
  SERVER="$(command -v llama-server)"
else
  echo "${RED}ERROR: llama-server not found in:${RESET}"
  echo "$LLAMA_DIR/build/bin/"
  echo "and it is not on your PATH either."
  exit 1
fi

[ -d "$LLAMA_DIR" ] && cd "$LLAMA_DIR"

echo
echo "${CYAN}========================================${RESET}"
echo "${CYAN}       Qwen Local LLM Server${RESET}"
echo "${CYAN}========================================${RESET}"
echo
echo "Model : ${LLAMA_MODEL_FILE:-$MODEL}"
echo "API   : http://127.0.0.1:${LLAMA_PORT:-8080}"
echo
echo "Starting llama-server..."
echo "Press Ctrl+C to stop the server."
echo

SERVER_ARGS=(--host 127.0.0.1 --port "${LLAMA_PORT:-8080}" -c 8192 -np 1 --jinja)
if [ -n "${LLAMA_MODEL_FILE:-}" ]; then
  SERVER_ARGS=(-m "$LLAMA_MODEL_FILE" "${SERVER_ARGS[@]}")
else
  SERVER_ARGS=(-hf "$MODEL" "${SERVER_ARGS[@]}")
fi

exec "$SERVER" "${SERVER_ARGS[@]}"