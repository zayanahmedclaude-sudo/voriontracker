# Vorion realtime (socket server + Redis)

The Socket.IO relay pushes live updates to the dashboard (status changes, screenshots, alerts, security events) and policy changes to agents. Redis backs the Socket.IO adapter so the relay can later run as several instances.

Installed on the VPS at `~/vorion-realtime`:

| Container | Network | Exposure |
|---|---|---|
| `vorion-socket` | `vorion_private` + `vorion_edge` | `127.0.0.1:4000` only; public as `wss://socket.vorionsystems.com` via the LiveKit Caddy |
| `vorion-redis` | `vorion_private` (internal) | none; password required; 64 MB memory cap, no persistence |

How the pieces connect:

- **Backend → relay:** `SOCKET_SERVER_URL=http://vorion-socket:4000`, set in `/opt/vorion-backend/.env`. Calls `/emit`, authenticated with `SOCKET_SERVER_SECRET`.
- **Dashboard and agents → relay:** `wss://socket.vorionsystems.com`, authenticated with the user's JWT.

## Settings

The real values live in `realtime/.env` on your PC (git-ignored) and are uploaded to `~/vorion-realtime/.env`. `JWT_SECRET` and `SOCKET_SERVER_SECRET` must equal the backend's.

## Install or update

From the repo root on your PC:

```bash
cp server/socket-server.js realtime/ && tar -cf - -C realtime . | ssh vorion-vps 'mkdir -p ~/vorion-realtime && tar -xf - -C ~/vorion-realtime' && rm realtime/socket-server.js
ssh vorion-vps 'cd ~/vorion-realtime && YES=1 ./setup.sh'
```

`./setup.sh status` shows container health and the internal and public `/health` checks.

## Publishing wss://socket.vorionsystems.com (one-time)

1. DNS: an A record `socket` pointing to the VPS IP.
2. On the VPS, apply the Caddy route that `setup.sh` prepared and validated. This needs sudo; the reload is graceful:
   ```bash
   sudo cp /opt/livekit/caddy.yaml /opt/livekit/caddy.yaml.bak-$(date +%Y%m%d%H%M%S) && sudo cp ~/vorion-realtime/caddy.yaml.new /opt/livekit/caddy.yaml && docker exec livekit-caddy-1 caddy reload --config /etc/caddy.yaml --adapter yaml
   ```
3. Clients:
   - **Dashboard:** set `NEXT_PUBLIC_SOCKET_SERVER_URL=https://socket.vorionsystems.com` in the dashboard host's environment and redeploy.
   - **Agent:** build with `SOCKET_SERVER_URL=https://socket.vorionsystems.com` so it is embedded.
4. Monitoring: add `https://socket.vorionsystems.com/health` to `PROBE_URLS` in `~/vorion-monitoring/.env`, then run `./setup.sh reload`.
