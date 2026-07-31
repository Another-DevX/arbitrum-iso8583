#!/usr/bin/env bash
# Local reproducible stack: PostgreSQL + middleware + UI.
# Arbitrum Sepolia is the chain environment; all application services run locally.
set -euo pipefail

if [[ -z "${RELAYER_PRIVATE_KEY:-}" ]] && [[ ! -f backend/.env ]]; then
  echo "RELAYER_PRIVATE_KEY is required. Export it or create an ignored backend/.env file." >&2
  exit 1
fi

echo "Starting the local M3 stack with Docker Compose..."
if [[ -f backend/.env ]]; then
  docker compose --env-file backend/.env up --build "$@"
else
  docker compose up --build "$@"
fi
