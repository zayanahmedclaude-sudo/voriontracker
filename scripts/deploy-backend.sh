#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/vorion-backend"
readonly BRANCH="zayan-work"
readonly SERVICE="backend"
readonly CONTAINER="vorion-backend"
readonly IMAGE_NAME="vorion-backend"
readonly PUBLIC_HEALTH_URL="https://api.vorionsystems.com/api/health"

DEPLOY_SHA="${1:-}"

if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "A valid 40-character Git commit SHA is required."
  exit 1
fi

exec 9>"/tmp/vorion-backend-deploy.lock"

if ! flock -n 9; then
  echo "Another backend deployment is already running."
  exit 1
fi

cd "$APP_DIR"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked VPS repository files contain uncommitted changes."
  exit 1
fi

echo "Fetching deployment commit..."
git fetch origin "$BRANCH"

if ! git cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null; then
  echo "Deployment commit does not exist."
  exit 1
fi

if ! git merge-base --is-ancestor "$DEPLOY_SHA" "origin/$BRANCH"; then
  echo "Deployment commit is not part of origin/$BRANCH."
  exit 1
fi

git switch "$BRANCH"
git merge --ff-only "$DEPLOY_SHA"

docker compose config --quiet

PREVIOUS_IMAGE_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
ROLLBACK_TAG="rollback-$(date -u +%Y%m%d%H%M%S)"

if [[ -n "$PREVIOUS_IMAGE_ID" ]]; then
  docker image tag "$PREVIOUS_IMAGE_ID" "$IMAGE_NAME:$ROLLBACK_TAG"
  echo "Created rollback image: $IMAGE_NAME:$ROLLBACK_TAG"
fi

echo "Building $IMAGE_NAME:$DEPLOY_SHA..."

docker build \
  --pull \
  --file Dockerfile.backend \
  --tag "$IMAGE_NAME:$DEPLOY_SHA" \
  .

rollback() {
  if [[ -z "$PREVIOUS_IMAGE_ID" ]]; then
    echo "No previous image is available for rollback."
    return 1
  fi

  echo "Deployment failed. Restoring $IMAGE_NAME:$ROLLBACK_TAG..."

  BACKEND_IMAGE_TAG="$ROLLBACK_TAG" \
    docker compose up \
      --detach \
      --no-deps \
      --force-recreate \
      --no-build \
      --wait \
      --wait-timeout 120 \
      "$SERVICE"

  docker image tag "$IMAGE_NAME:$ROLLBACK_TAG" "$IMAGE_NAME:latest"

  echo "Rollback completed."
}

echo "Starting the new backend..."

if ! BACKEND_IMAGE_TAG="$DEPLOY_SHA" \
  docker compose up \
    --detach \
    --no-deps \
    --force-recreate \
    --no-build \
    --wait \
    --wait-timeout 120 \
    "$SERVICE"
then
  rollback
  exit 1
fi

HEALTHY=false

for attempt in $(seq 1 12); do
  if curl --fail --silent --show-error \
    --max-time 10 \
    "$PUBLIC_HEALTH_URL" >/dev/null
  then
    HEALTHY=true
    break
  fi

  echo "Public health check attempt $attempt failed."
  sleep 5
done

if [[ "$HEALTHY" != "true" ]]; then
  docker compose logs --tail=100 "$SERVICE" || true
  rollback
  exit 1
fi

docker image tag "$IMAGE_NAME:$DEPLOY_SHA" "$IMAGE_NAME:latest"
if ! /opt/vorion-backend/scripts/cleanup-backend-images.sh; then
  echo "Warning: deployment succeeded, but image cleanup failed."
fi
echo "Deployment successful."
echo "Commit: $DEPLOY_SHA"
docker compose ps "$SERVICE"
