# CI/CD setup for Vorion

This repo now includes [`.github/workflows/ci-cd.yml`](C:\Users\ZT\Desktop\Products\Vorion Tracker\voriontracker\.github\workflows\ci-cd.yml), which does three things:

1. On every push to any branch, it installs dependencies, runs tests, and builds the app.
2. If the workflow fails, it sends an email.
3. If the push is on `main`, it deploys the backend to your VPS over SSH, restarts it, and checks the backend health endpoint.

## Deployment shape this workflow assumes

- Frontend is hosted on Vercel.
- Backend runs on your Namecheap VPS.
- GitHub is the source of truth.
- `main` is the production deployment branch.

So the workflow does not try to redeploy Vercel. It only handles CI plus backend deployment to the VPS.

## How the VPS deployment works

On a successful push to `main`, GitHub Actions:

1. Connects to your VPS over SSH.
2. Goes to your app folder.
3. Runs `git fetch`, `git checkout <branch>`, and `git pull`.
4. Runs `npm ci`, `npm test`, and `npm run build`.
5. Optionally runs a migration command.
6. Runs your restart command.
7. Calls your backend health URL and fails the workflow if the backend is not healthy.

This replaces the manual `ssh -> git pull -> rebuild -> restart` flow.

## GitHub secrets to add

Add these in `GitHub -> Settings -> Secrets and variables -> Actions`.

### Required for the app build

- `DATABASE_URL`
- `JWT_SECRET`
- `NEXT_PUBLIC_APP_URL`
- `PUSHER_APP_ID`
- `PUSHER_KEY`
- `PUSHER_SECRET`
- `PUSHER_CLUSTER`
- `NEXT_PUBLIC_PUSHER_KEY`
- `NEXT_PUBLIC_PUSHER_CLUSTER`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_WS_URL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

If your build does not actually need some of these, you can remove them from the workflow later.

### Required for VPS deployment

- `VPS_HOST`
- `VPS_PORT`
- `VPS_USER`
- `VPS_SSH_PRIVATE_KEY`
- `VPS_DEPLOY_PATH`
- `VPS_RESTART_COMMAND`
- `BACKEND_HEALTHCHECK_URL`

Optional:

- `VPS_MIGRATE_COMMAND`

Example values:

- `VPS_HOST`: `your-vps-ip-or-domain`
- `VPS_PORT`: `22`
- `VPS_USER`: `deploy`
- `VPS_DEPLOY_PATH`: `/var/www/voriontracker`
- `VPS_RESTART_COMMAND`: `pm2 restart vorion-backend`
- `VPS_MIGRATE_COMMAND`: `node scripts/migrate.js`
- `BACKEND_HEALTHCHECK_URL`: `https://api.yourdomain.com/api/health`

If you use `systemd` instead of `pm2`, `VPS_RESTART_COMMAND` can be:

```bash
sudo systemctl restart vorion-backend
```

If you use a custom deploy script on the VPS, `VPS_RESTART_COMMAND` can be:

```bash
./deploy/restart-backend.sh
```

### Required for failure emails

- `CI_SMTP_HOST`
- `CI_SMTP_PORT`
- `CI_SMTP_SECURE`
- `CI_SMTP_USER`
- `CI_SMTP_PASS`
- `CI_ALERT_TO`
- `CI_ALERT_FROM`

Example values:

- `CI_SMTP_HOST`: `smtp.gmail.com`
- `CI_SMTP_PORT`: `465`
- `CI_SMTP_SECURE`: `true`
- `CI_ALERT_FROM`: `Vorion CI <your-email@gmail.com>`

If you use Gmail, use an App Password instead of your normal account password.

## Recommended GitHub settings

To keep production safe:

1. Protect the `main` branch.
2. Require the `CI/CD / build-and-test` check before merge.
3. Do day-to-day work in feature branches and merge into `main` only when ready to auto-deploy the backend.

## Branch behavior

- Feature branches: build/test only, plus email if broken.
- `main`: build/test, deploy backend to VPS, then verify the backend health endpoint.

If you want a different branch to deploy to production, change this line in the workflow:

```yaml
if: github.ref == 'refs/heads/main'
```

## Health check behavior

The workflow uses [app/api/health/route.ts](C:\Users\ZT\Desktop\Products\Vorion Tracker\voriontracker\app\api\health\route.ts), which currently returns:

```json
{ "ok": true }
```

That is enough for basic reachability. If you want a stronger deployment gate, expand the endpoint so it also checks your database connection or any other critical dependency before returning success.

## SSH key setup

Create a dedicated deploy key pair for GitHub Actions and add the public key to your VPS user's `~/.ssh/authorized_keys`.

```bash
ssh-keygen -t ed25519 -C "github-actions-vorion" -f github-actions-vorion
```

Then:

1. Put the contents of `github-actions-vorion` into the GitHub secret `VPS_SSH_PRIVATE_KEY`.
2. Put the contents of `github-actions-vorion.pub` into the VPS user's `~/.ssh/authorized_keys`.

## One important requirement on the VPS

The folder in `VPS_DEPLOY_PATH` must already be a working git checkout of this repo and must already have its runtime `.env` file in place.

The workflow will update code and restart the service, but it does not create server environment files for you.
