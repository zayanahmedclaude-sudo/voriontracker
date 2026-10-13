# Vorion monitoring

Prometheus + Alertmanager with exporters on the VPS, plus the **Health** page for super admins in the web dashboard.

Installed on the VPS at `~/vorion-monitoring` (user `zayan`). The default stack is sized for the 2 GB VPS: it uses about 65 MB of RAM. The Health page is the monitoring screen. Grafana is optional (see below).

## What gets watched

| Area | How | Alert when |
|---|---|---|
| Public endpoints (API, dashboard, LiveKit) | Blackbox probes every 30s from the VPS | Down for 2 min, slower than 3s, TLS cert expiring within 14 days |
| Backend container | Internal probe of `http://vorion-backend:3000/api/health` | Down for 2 min |
| API internals | `GET /api/metrics` (token-protected) | API metrics unreachable, a dependency check (DB, R2, socket server, LiveKit) failing, 5xx spikes, error spikes, restart loop, high memory |
| Database | `postgres-exporter` (read-only `vorion_monitor` role) + the API's own DB check | Postgres down, connections over 80%, pool waiting, queries over 5 min |
| Tracking | Agent and screenshot counts from the API | No screenshots fleet-wide while people are checked in, many open capture alerts |
| VPS | `node-exporter` | CPU over 90%, memory over 90%, swap over 75%, disk under 15% free or filling within 24h |

Alerts are e-mailed to `ALERT_EMAIL_TO` through the same SMTP account as the app, and sent again when resolved. Firing alerts also appear on the Health page.

## Install or update

From your PC (repo root), copy the folder and run setup:

```bash
tar --exclude='monitoring/.env' --exclude='monitoring/rendered' -cf - monitoring | ssh vorion-vps 'mkdir -p ~/vorion-monitoring && tar -xf - -C ~/vorion-monitoring --strip-components=1'
ssh vorion-vps 'cd ~/vorion-monitoring && ./setup.sh'
```

`setup.sh` fills in what it can automatically:

- generates `METRICS_TOKEN`
- copies SMTP settings from `/opt/vorion-backend/.env`
- creates the read-only `vorion_monitor` database role with a random password

It then validates every config, starts the stack and lists each target. It also offers to add `METRICS_TOKEN` and `PROMETHEUS_URL` to the backend `.env` (`YES=1` skips the prompt). Settings live in `~/vorion-monitoring/.env` (mode 600, never commit it).

The backend must run the current code with those settings for the `vorion-api` target and the Health page to work.

## Day-to-day

```bash
ssh vorion-vps 'cd ~/vorion-monitoring && ./setup.sh status'   # containers + every target
ssh vorion-vps 'cd ~/vorion-monitoring && ./setup.sh reload'   # after editing .env or alerts.yml
ssh vorion-vps 'docker logs vorion-alertmanager --tail 50'     # e-mail delivery problems
```

Prometheus UI (graphs, alert states): `ssh -L 9090:localhost:9090 vorion-vps`, then open http://localhost:9090.

Send a test alert e-mail:

```bash
ssh vorion-vps "docker exec vorion-alertmanager amtool alert add TestAlert severity=warning --annotation=summary='Test from Vorion monitoring' --alertmanager.url=http://localhost:9093"
```

## Optional: Grafana

Needs about 400 MB more RAM, so upgrade the VPS to 4 GB first. Then set the following in `~/vorion-monitoring/.env` and run `./setup.sh`:

```
COMPOSE_PROFILES=full
GRAFANA_ADMIN_PASSWORD=<12+ characters>
```

This adds Grafana (dashboard **Vorion › Vorion overview**) and cAdvisor container metrics. Open it with `ssh -L 3001:localhost:3001 vorion-vps`. To publish it on a domain, Grafana is on the `vorion_edge` network as `vorion-grafana:3000`.

Data retention: 15 days or 1 GB, whichever comes first.
