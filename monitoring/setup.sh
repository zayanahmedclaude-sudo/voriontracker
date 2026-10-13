#!/usr/bin/env bash
# Vorion monitoring setup. Run on the VPS from this folder:
#   ./setup.sh          fill settings, render configs, validate, start/update the stack
#   ./setup.sh reload   re-render configs and reload Prometheus/Alertmanager
#   ./setup.sh status   show container and scrape-target status
# Set YES=1 to apply backend .env changes without prompting.
set -Eeuo pipefail

cd "$(dirname "$0")"
readonly ENV_FILE=".env"
readonly RENDERED="rendered"
readonly PROM_IMAGE="prom/prometheus:v2.55.1"
readonly AM_IMAGE="prom/alertmanager:v0.27.0"
MODE="${1:-install}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m ✗ %s\033[0m\n' "$*" >&2; exit 1; }

require_tools() {
  command -v docker >/dev/null || fail "Docker is not installed."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose ...)."
  command -v perl >/dev/null || fail "perl is required (apt install perl)."
  command -v curl >/dev/null || fail "curl is required (apt install curl)."
}

# Read KEY's value from an env file without shell expansion, so secrets
# containing $ or ` stay intact. Surrounding quotes and spaces are removed.
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
  if [[ ! -f "$ENV_FILE" ]]; then
    cp .env.example "$ENV_FILE"
    ok "Created $ENV_FILE from the example."
  fi
  chmod 600 "$ENV_FILE"
  local key
  for key in $(perl -ne 'print "$1\n" if /^([A-Za-z_][A-Za-z0-9_]*)=/' "$ENV_FILE"); do
    export "$key=$(read_env_value "$ENV_FILE" "$key")"
  done
  BACKEND_ENV="${BACKEND_ENV:-/opt/vorion-backend/.env}"
}

# Write KEY='value' into .env (replacing an existing line) without echoing it.
set_env_value() {
  local key="$1" value="$2"
  [[ "$value" != *"'"* ]] || fail "Cannot store $key: the value contains a single quote. Set it in $ENV_FILE by hand."
  KEY="$key" VALUE="$value" perl -0pi -e '
    my $line = "$ENV{KEY}=\x27$ENV{VALUE}\x27";
    s/^\Q$ENV{KEY}\E=.*$/$line/m or $_ .= "\n$line\n";
  ' "$ENV_FILE"
  export "$key=$value"
}

random_hex() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

autofill_metrics_token() {
  [[ -z "${METRICS_TOKEN:-}" ]] || return 0
  set_env_value METRICS_TOKEN "$(random_hex)"
  ok "Generated METRICS_TOKEN."
}

autofill_smtp() {
  [[ -z "${SMTP_SMARTHOST:-}" ]] || return 0
  local host port user pass from
  host="$(read_env_value "$BACKEND_ENV" SMTP_HOST)"
  [[ -n "$host" ]] || { warn "SMTP settings are empty and $BACKEND_ENV has no SMTP_HOST; fill them in $ENV_FILE."; return 0; }
  port="$(read_env_value "$BACKEND_ENV" SMTP_PORT)"
  user="$(read_env_value "$BACKEND_ENV" SMTP_USER)"
  pass="$(read_env_value "$BACKEND_ENV" SMTP_PASS)"
  from="$(read_env_value "$BACKEND_ENV" SMTP_FROM_EMAIL)"
  set_env_value SMTP_SMARTHOST "$host:${port:-587}"
  set_env_value SMTP_USERNAME "$user"
  set_env_value SMTP_PASSWORD "$pass"
  set_env_value SMTP_FROM "${from:-$user}"
  ok "Copied SMTP settings from $BACKEND_ENV (values not shown)."
}

# Create a read-only vorion_monitor role with a random password and point the
# exporter at Postgres directly on the Docker network.
autofill_postgres() {
  [[ -z "${POSTGRES_EXPORTER_DSN:-}" ]] || return 0
  local container="${POSTGRES_CONTAINER:-vorion-postgres}"
  docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true \
    || fail "POSTGRES_EXPORTER_DSN is empty and container '$container' is not running. Set the DSN in $ENV_FILE."
  local superuser db password
  superuser="$(docker exec "$container" printenv POSTGRES_USER)"
  db="$(docker exec "$container" printenv POSTGRES_DB)"
  password="$(random_hex)"
  # SQL goes over stdin so the password never appears in a process list.
  docker exec -i "$container" psql -U "$superuser" -d "$db" -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vorion_monitor') THEN
    CREATE ROLE vorion_monitor LOGIN;
  END IF;
END
\$\$;
ALTER ROLE vorion_monitor WITH LOGIN PASSWORD '$password';
ALTER ROLE vorion_monitor SET statement_timeout = '10s';
GRANT pg_monitor TO vorion_monitor;
GRANT CONNECT ON DATABASE "$db" TO vorion_monitor;
SQL
  set_env_value POSTGRES_EXPORTER_DSN "postgresql://vorion_monitor:$password@$container:5432/$db?sslmode=disable"
  ok "Created read-only database role vorion_monitor (pg_monitor) for the exporter."
}

full_profile() { [[ ",${COMPOSE_PROFILES:-}," == *",full,"* ]]; }

validate_env() {
  autofill_metrics_token
  autofill_smtp
  autofill_postgres
  local name
  for name in BACKEND_TARGET POSTGRES_EXPORTER_DSN ALERT_EMAIL_TO SMTP_SMARTHOST SMTP_FROM PROBE_URLS INTERNAL_PROBE_URLS; do
    [[ -n "${!name:-}" ]] || fail "$name is not set in $ENV_FILE."
  done
  [[ -n "${SMTP_USERNAME:-}" && -n "${SMTP_PASSWORD:-}" ]] || warn "SMTP_USERNAME/SMTP_PASSWORD are empty: alert e-mails will fail unless your SMTP server needs no login."
  if full_profile; then
    [[ "${#GRAFANA_ADMIN_PASSWORD}" -ge 12 ]] || fail "COMPOSE_PROFILES=full needs GRAFANA_ADMIN_PASSWORD (12+ characters)."
  fi
  for network in "${APP_NETWORK:-vorion_private}" "${EDGE_NETWORK:-vorion_edge}"; do
    docker network inspect "$network" >/dev/null 2>&1 || fail "Docker network '$network' does not exist. Is the backend deployed?"
  done
  ok "Settings are complete."
}

# ${VAR} -> value (YAML single-quote escaped); @@LIST@@ markers -> YAML lists.
render() {
  local template="$1" output="$2"
  CADVISOR_JOB="$(full_profile && printf '  - job_name: cadvisor\n    static_configs:\n      - targets: [\x27vorion-cadvisor:8080\x27]\n' || true)" \
  perl -pe '
    s/\$\{([A-Z0-9_]+)\}/exists $ENV{$1} ? ($ENV{$1} =~ s{\x27}{\x27\x27}gr) : die "missing variable $1\n"/ge;
    if (/^\@\@CADVISOR_JOB\@\@$/) { $_ = $ENV{CADVISOR_JOB}; }
    elsif (/^\@\@(PROBE_TARGETS|INTERNAL_PROBE_TARGETS)\@\@$/) {
      my $name = $1 eq "PROBE_TARGETS" ? "PROBE_URLS" : "INTERNAL_PROBE_URLS";
      my @urls = grep { length } map { s/^\s+|\s+$//gr } split /,/, ($ENV{$name} // "");
      die "$name has no URLs\n" unless @urls;
      $_ = join("", map { "          - \x27$_\x27\n" } @urls);
    }
  ' "$template" > "$output"
}

render_configs() {
  info "Rendering configuration"
  mkdir -p "$RENDERED"
  chmod 700 "$RENDERED"
  render prometheus/prometheus.yml.template "$RENDERED/prometheus.yml"
  render alertmanager/alertmanager.yml.template "$RENDERED/alertmanager.yml"
  printf '%s' "$METRICS_TOKEN" > "$RENDERED/metrics_token"
  # Containers run as an unprivileged user and must read these files; the
  # directory itself stays closed to other host users.
  chmod 644 "$RENDERED"/prometheus.yml "$RENDERED"/alertmanager.yml "$RENDERED"/metrics_token
  ok "Rendered prometheus.yml and alertmanager.yml"
}

validate_configs() {
  info "Validating configuration"
  docker run --rm --entrypoint promtool \
    -v "$PWD/$RENDERED/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$PWD/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro" \
    -v "$PWD/$RENDERED/metrics_token:/etc/prometheus/metrics_token:ro" \
    "$PROM_IMAGE" check config /etc/prometheus/prometheus.yml \
    || fail "Prometheus configuration is invalid."
  docker run --rm --entrypoint amtool \
    -v "$PWD/$RENDERED/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
    "$AM_IMAGE" check-config /etc/alertmanager/alertmanager.yml >/dev/null \
    || fail "Alertmanager configuration is invalid."
  docker compose config --quiet || fail "docker-compose.yml is invalid."
  ok "Prometheus, Alertmanager and Compose configs are valid."
}

wait_for() {
  local name="$1" url="$2"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then ok "$name is up"; return 0; fi
    sleep 2
  done
  fail "$name did not become ready ($url). Check: docker compose logs $3"
}

show_status() {
  info "Containers"
  docker compose ps --format '{{.Name}}: {{.Status}}'
  info "Scrape targets (Prometheus)"
  curl -fsS --max-time 5 http://127.0.0.1:9090/api/v1/targets | perl -MJSON::PP -0e '
    my $data = decode_json(<STDIN>);
    for my $t (sort { $a->{labels}{job} cmp $b->{labels}{job} } @{ $data->{data}{activeTargets} }) {
      my $mark = $t->{health} eq "up" ? "\e[32mUP  \e[0m" : $t->{health} eq "down" ? "\e[31mDOWN\e[0m" : "\e[33mWAIT\e[0m";
      printf "  %s %-20s %s%s\n", $mark, $t->{labels}{job}, $t->{labels}{instance}, $t->{lastError} ? "  ($t->{lastError})" : "";
    }' || warn "Could not read targets from Prometheus."
}

# The API needs the same token, plus where to find Prometheus (and Grafana).
update_backend_env() {
  local lines=("METRICS_TOKEN=$METRICS_TOKEN" "PROMETHEUS_URL=http://vorion-prometheus:9090")
  full_profile && lines+=("GRAFANA_PUBLIC_URL=$GRAFANA_ROOT_URL")
  info "Backend settings ($BACKEND_ENV)"
  if [[ ! -w "$BACKEND_ENV" ]]; then
    warn "Cannot write $BACKEND_ENV. Add these lines, then redeploy the backend:"
    printf '      %s\n' "${lines[@]%%=*}=…"
    return
  fi
  local existing
  existing="$(read_env_value "$BACKEND_ENV" METRICS_TOKEN)"
  if [[ -n "$existing" && "$existing" != "$METRICS_TOKEN" ]]; then
    warn "$BACKEND_ENV has a different METRICS_TOKEN. Make them match, or the vorion-api target shows 401."
    return
  fi
  local missing=() line
  for line in "${lines[@]}"; do grep -q "^${line%%=*}=" "$BACKEND_ENV" || missing+=("$line"); done
  if [[ ${#missing[@]} -eq 0 ]]; then ok "Backend .env already has the monitoring settings."; return; fi
  if [[ "${YES:-}" != "1" ]]; then
    [[ -t 0 ]] || { warn "Run with YES=1 to add ${missing[*]%%=*} to $BACKEND_ENV."; return; }
    read -r -p "    Add ${missing[*]%%=*} to $BACKEND_ENV? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || { warn "Skipped. Add them yourself before redeploying the backend."; return; }
  fi
  cp -p "$BACKEND_ENV" "$BACKEND_ENV.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# Monitoring (added by monitoring/setup.sh)\n' >> "$BACKEND_ENV"
  printf '%s\n' "${missing[@]}" >> "$BACKEND_ENV"
  ok "Added ${missing[*]%%=*} to $BACKEND_ENV (backup saved next to it). Redeploy the backend to apply."
}

main() {
  require_tools
  case "$MODE" in
    status) show_status; exit 0 ;;
    install|reload) ;;
    *) fail "Unknown command '$MODE'. Use: ./setup.sh [install|reload|status]" ;;
  esac
  load_env
  validate_env
  render_configs
  validate_configs
  if [[ "$MODE" == "reload" ]]; then
    docker compose up -d --remove-orphans
    curl -fsS -X POST http://127.0.0.1:9090/-/reload && ok "Prometheus reloaded"
    curl -fsS -X POST http://127.0.0.1:9093/-/reload && ok "Alertmanager reloaded"
    exit 0
  fi
  info "Starting the monitoring stack"
  docker compose pull --quiet
  docker compose up -d --remove-orphans
  wait_for Prometheus http://127.0.0.1:9090/-/ready prometheus
  wait_for Alertmanager http://127.0.0.1:9093/-/ready alertmanager
  full_profile && wait_for Grafana http://127.0.0.1:3001/api/health grafana
  info "Waiting 40s for the first scrapes"
  sleep 40
  show_status
  update_backend_env
  echo
  ok "Monitoring is running."
  echo "  Prometheus: http://127.0.0.1:9090 (VPS only). From your PC: ssh -L 9090:localhost:9090 <user>@<vps>"
  full_profile && echo "  Grafana:    $GRAFANA_ROOT_URL → dashboard \"Vorion overview\""
  echo "  The vorion-api target stays DOWN until the backend runs the new code with METRICS_TOKEN."
  echo "  Re-check any time with: ./setup.sh status"
}

main
