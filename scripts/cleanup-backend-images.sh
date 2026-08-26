#!/usr/bin/env bash
set -Eeuo pipefail

readonly IMAGE_NAME="vorion-backend"
readonly CONTAINER_NAME="vorion-backend"
readonly ROLLBACKS_TO_KEEP=2

CURRENT_REFERENCE="$(
  docker inspect "$CONTAINER_NAME" \
    --format '{{.Config.Image}}' 2>/dev/null || true
)"

CURRENT_TAG="${CURRENT_REFERENCE#${IMAGE_NAME}:}"
ROLLBACKS_SEEN=0

echo "Current backend image: ${CURRENT_REFERENCE:-unknown}"

while IFS= read -r TAG; do
  [[ -z "$TAG" ]] && continue

  case "$TAG" in
    latest)
      continue
      ;;

    "$CURRENT_TAG")
      continue
      ;;

    rollback-*)
      ROLLBACKS_SEEN=$((ROLLBACKS_SEEN + 1))

      if (( ROLLBACKS_SEEN <= ROLLBACKS_TO_KEEP )); then
        echo "Keeping rollback image: $IMAGE_NAME:$TAG"
        continue
      fi

      echo "Removing old rollback tag: $IMAGE_NAME:$TAG"
      docker image rm "$IMAGE_NAME:$TAG" || true
      ;;

    *)
      if [[ "$TAG" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Removing old deployment tag: $IMAGE_NAME:$TAG"
        docker image rm "$IMAGE_NAME:$TAG" || true
      fi
      ;;
  esac
done < <(
  docker image ls "$IMAGE_NAME" \
    --format '{{.Tag}}'
)

echo "Removing dangling images older than seven days..."
docker image prune \
  --force \
  --filter 'until=168h'

echo "Removing build cache older than seven days..."
docker builder prune \
  --force \
  --keep-storage 2GB
echo "Backend image cleanup completed."
