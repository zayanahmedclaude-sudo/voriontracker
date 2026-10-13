#!/usr/bin/env bash
# Vorion realtime setup (Socket.IO relay + Redis). Run on the VPS from this folder,
# after uploading .env (kept locally as realtime/.env):
#   ./setup.sh          build, start/update, prepare the Caddy route
#   ./setup.sh status   container health and endpoint checks
# Set YES=1 to apply backend .env changes without prompting.
set -Eeuo pipefail

cd "$(dirname "$0")"
readonly ENV_FILE=".env"
readonly CADDY_FILE="${CADDY_FILE:-/opt/livekit/caddy.yaml}"
readonly CADDY_CONTAINER="${CADDY_CONTAINER:-livekit-caddy-1}"
MODE="${1:-install}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m ✗ %s\033[0m\n' "$*" >&2; exit 1; }

read_env_value() {
  local file="$1" key="$2"
  [[ -r "$file" ]] || return 0
  KEY="$key" perl -ne '
    next unless /^\s*\Q$ENV{KEY}\E\s*=(.*)$/;
    my $v = $1; $v =~ s/^\s+|\s+$//g; $v =~ s/^(["\x27])(.*)\1$/$2/;
    $last = $v;
    END { print $last if defined $last }
  ' "$file"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || fail "$ENV_FILE is missing. Upload realtime/.env from your PC first."
  chmod 600 "$ENV_FILE"
  local key
  for key in $(perl -ne 'print "$1\n" if /^([A-Za-z_][A-Za-z0-9_]*)=/' "$ENV_FILE"); do
    export "$key=$(read_env_value "$ENV_FILE" "$key")"
  done
  BACKEND_ENV="${BACKEND_ENV:-/opt/vorion-backend/.env}"
  SOCKET_DOMAIN="${SOCKET_DOMAIN:-socket.vorionsystems.com}"
}

validate_env() {
  local key
  for key in JWT_SECRET SOCKET_SERVER_SECRET REDIS_PASSWORD SOCKET_CLIENT_ORIGIN; do
    [[ -n "${!key:-}" ]] || fail "$key is not set in $ENV_FILE."
  done
  [[ "$REDIS_PASSWORD" =~ ^[A-Za-z0-9]+$ ]] || fail "REDIS_PASSWORD must be letters and digits only (it is used in a URL)."
  docker network inspect "${APP_NETWORK:-vorion_private}" >/dev/null 2>&1 || fail "Docker network ${APP_NETWORK:-vorion_private} does not exist."
  ok "Settings are complete."
}

start_stack() {
  [[ -f socket-server.js ]] || { [[ -f ../server/socket-server.js ]] && cp ../server/socket-server.js .; }
  [[ -f socket-server.js ]] || fail "socket-server.js is missing (copy server/socket-server.js here)."
  info "Building and starting the socket server and Redis"
  docker compose up -d --build --remove-orphans
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 http://127.0.0.1:4000/health 2>/dev/null | grep -q '"redis":"connected"'; then
      ok "Socket server is up and connected to Redis"; return 0
    fi
    sleep 2
  done
  docker compose logs --tail 40 socket
  fail "Socket server did not become healthy."
}

# The LiveKit Caddy terminates TLS on :443 and routes by domain. Prepare a
# copy of its config with the socket domain added and validate it; applying
# it needs sudo, so that step is printed for you to run.
prepare_caddy() {
  info "Caddy route for $SOCKET_DOMAIN"
  [[ -r "$CADDY_FILE" ]] || { warn "$CADDY_FILE not readable; add the route by hand (see README)."; return 0; }
  if grep -q "$SOCKET_DOMAIN" "$CADDY_FILE"; then ok "$CADDY_FILE already routes $SOCKET_DOMAIN."; return 0; fi
  DOMAIN="$SOCKET_DOMAIN" perl -0pe '
    my $d = $ENV{DOMAIN};
    s/(\n(\s+)- api\.vorionsystems\.com\n)/$1$2- $d\n/ or die "automate list not found\n";
    $_ .= "\n" unless /\n\z/;
    $_ .= "\n          - match:\n              - tls:\n                  sni:\n                    - \"$d\"\n            handle:\n              - handler: tls\n                connection_policies:\n                  - alpn: [\"http/1.1\"]\n              - handler: proxy\n                upstreams:\n                  - dial: [\"localhost:4000\"]\n";
  ' "$CADDY_FILE" > caddy.yaml.new
  docker cp caddy.yaml.new "$CADDY_CONTAINER:/tmp/caddy.yaml.new" >/dev/null
  if docker exec "$CADDY_CONTAINER" caddy validate --config /tmp/caddy.yaml.new --adapter yaml >/dev/null 2>&1; then
    ok "Prepared and validated $(pwd)/caddy.yaml.new"
    CADDY_PENDING=1
  else
    docker exec "$CADDY_CONTAINER" caddy validate --config /tmp/caddy.yaml.new --adapter yaml || true
    warn "The prepared Caddy config did not validate; nothing was changed."
  fi
  docker exec "$CADDY_CONTAINER" rm -f /tmp/caddy.yaml.new >/dev/null 2>&1 || true
}

update_backend_env() {
  local line="SOCKET_SERVER_URL=http://vorion-socket:4000"
  info "Backend settings ($BACKEND_ENV)"
  if grep -q '^SOCKET_SERVER_URL=' "$BACKEND_ENV" 2>/dev/null; then ok "Backend already has SOCKET_SERVER_URL."; return; fi
  [[ -w "$BACKEND_ENV" ]] || { warn "Cannot write $BACKEND_ENV; add: $line"; return; }
  if [[ "${YES:-}" != "1" ]]; then
    [[ -t 0 ]] || { warn "Run with YES=1 to add SOCKET_SERVER_URL to $BACKEND_ENV."; return; }
    read -r -p "    Add SOCKET_SERVER_URL to $BACKEND_ENV? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || { warn "Skipped."; return; }
  fi
  mkdir -p "$HOME/backups" && chmod 700 "$HOME/backups"
  cp -p "$BACKEND_ENV" "$HOME/backups/.env.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# Realtime (added by realtime/setup.sh)\n%s\n' "$line" >> "$BACKEND_ENV"
  ok "Added SOCKET_SERVER_URL (backup in ~/backups). Restart or redeploy the backend to apply."
}

show_status() {
  info "Containers"
  docker compose ps --format '{{.Name}}: {{.Status}}'
  info "Health"
  printf '  internal: '; curl -sS --max-time 5 http://127.0.0.1:4000/health || echo "unreachable"; echo
  printf '  public:   '; curl -sS --max-time 8 "https://$SOCKET_DOMAIN/health" 2>/dev/null || echo "not reachable yet (DNS record or Caddy route missing)"; echo
}

main() {
  command -v docker >/dev/null || fail "Docker is not installed."
  load_env
  case "$MODE" in
    status) show_status; exit 0 ;;
    install) ;;
    *) fail "Unknown command '$MODE'. Use: ./setup.sh [install|status]" ;;
  esac
  CADDY_PENDING=0
  validate_env
  start_stack
  update_backend_env
  prepare_caddy
  show_status
  if [[ "$CADDY_PENDING" == "1" ]]; then
    cat <<EOF

 Two manual steps publish wss://$SOCKET_DOMAIN:
   1. DNS: add an A record  ${SOCKET_DOMAIN%%.*}  ->  this server's IP.
   2. Apply the Caddy route (needs sudo; the reload is graceful, no downtime):
        sudo cp $CADDY_FILE $CADDY_FILE.bak-\$(date +%Y%m%d%H%M%S) && sudo cp $(pwd)/caddy.yaml.new $CADDY_FILE && docker exec $CADDY_CONTAINER caddy reload --config /etc/caddy.yaml --adapter yaml
EOF
  fi
}

main
