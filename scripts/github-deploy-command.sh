#!/usr/bin/env bash
set -Eeuo pipefail

ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND:-}"

if [[ ! "$ORIGINAL_COMMAND" =~ ^deploy[[:space:]]([0-9a-f]{40})$ ]]; then
  echo "Only a valid backend deployment command is permitted."
  exit 1
fi

DEPLOY_SHA="${BASH_REMATCH[1]}"

exec /opt/vorion-backend/scripts/deploy-backend.sh "$DEPLOY_SHA"
