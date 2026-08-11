# WorkTrack — Complete Deployment Guide
## Go live on Vercel + Neon in under 1 hour

---

## PART 1 — Deploy the dashboard to Vercel (30 min)

### Step 1 — Push to GitHub

```bash
cd worktrack-vercel
git init
git add .
git commit -m "Initial WorkTrack deployment"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/worktrack.git
git push -u origin main
```

---

### Step 2 — Create Neon database (free)

1. Go to **https://neon.tech** → Sign up (free)
2. Click **"New Project"** → name it `worktrack`
3. Choose region closest to your team (e.g. `ap-southeast-1` for Pakistan)
4. Copy the **Connection string** — looks like:
   ```
   postgresql://worktrack_owner:xxxx@ep-xxx.ap-southeast-1.aws.neon.tech/worktrack?sslmode=require
   ```
5. Keep this tab open — you'll need it in Step 4

---

### Step 3 — Create Pusher app (free, for live monitor)

1. Go to **https://pusher.com** → Sign up → **"Create app"**
2. Name: `worktrack`, Cluster: `ap2` (closest to Pakistan)
3. Go to **App Keys** tab, copy:
   - App ID
   - Key
   - Secret
   - Cluster

---

### Step 4 — Deploy on Vercel

1. Go to **https://vercel.com** → Sign up with GitHub
2. Click **"Add New Project"** → Import your `worktrack` repo
3. Framework: **Next.js** (auto-detected)
4. Click **"Environment Variables"** and add ALL of these:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Your Neon connection string from Step 2 |
| `JWT_SECRET` | Any long random string (e.g. `openssl rand -base64 32` output) |
| `BLOB_READ_WRITE_TOKEN` | *(add after Step 5)* |
| `PUSHER_APP_ID` | From Step 3 |
| `PUSHER_KEY` | From Step 3 |
| `PUSHER_SECRET` | From Step 3 |
| `PUSHER_CLUSTER` | `ap2` |
| `NEXT_PUBLIC_PUSHER_KEY` | Same as PUSHER_KEY |
| `NEXT_PUBLIC_PUSHER_CLUSTER` | `ap2` |
| `NEXT_PUBLIC_APP_URL` | `https://your-project.vercel.app` *(fill after deploy)* |

5. Click **"Deploy"** → wait ~2 minutes

---

### Step 5 — Add Vercel Blob (screenshot storage)

1. In your Vercel project → **Storage** tab
2. Click **"Create Database"** → select **Blob**
3. Name: `worktrack-screenshots` → Create
4. Vercel auto-adds `BLOB_READ_WRITE_TOKEN` to your env vars
5. Go to **Settings → Environment Variables** → verify it's there
6. **Redeploy**: Deployments → latest → **"Redeploy"**

---

### Step 6 — Run database migration

On your local machine (with the repo):

```bash
# Copy the example env file
cp .env.example .env.local

# Edit .env.local — paste your DATABASE_URL from Neon
nano .env.local

# Run the migration (creates all tables + default admin)
npm install
node scripts/migrate.js
```

You should see:
```
✓ Default admin: admin@company.com / admin123
✓ All migrations complete
```

---

### Step 7 — Test your dashboard

1. Visit `https://your-project.vercel.app`
2. Login with `admin@company.com` / `admin123`
3. **IMMEDIATELY** go to User Management → change the admin password

---

## PART 2 — Build & distribute the agent (20 min)

### Step 8 — Configure agent with your Vercel URL

```bash
cd agent

# Edit src/main.ts line 7 — replace with your actual Vercel URL:
# const SERVER_URL = process.env.WORKTRACK_SERVER || 'https://YOUR-APP.vercel.app';
```

Also update the install scripts:
```bash
# In scripts/install-linux.sh — line 9:
APP_URL="${WORKTRACK_SERVER:-https://YOUR-APP.vercel.app}"

# In scripts/install-windows.ps1 — line 8:
[string]$ServerUrl = "https://YOUR-APP.vercel.app"

# In scripts/install-mac.sh — line 9:
APP_URL="${WORKTRACK_SERVER:-https://YOUR-APP.vercel.app}"
```

---

### Step 9 — Build the agent installers

```bash
cd agent
npm install

# Build for your current platform:
npm run build

# Build for all platforms (needs Mac for .dmg, Windows for .exe):
npm run build -- --mac --win --linux

# Outputs:
# dist/WorkTrack Agent Setup 1.0.0.exe     ← Windows installer
# dist/WorkTrack Agent-1.0.0.dmg           ← macOS disk image
# dist/WorkTrack Agent-1.0.0.AppImage      ← Linux AppImage
# dist/WorkTrack Agent-1.0.0.tar.gz        ← Linux tar.gz
```

> **Cross-platform builds:** To build .exe on Mac or Linux, use GitHub Actions
> (see Step 10B below). To build .dmg on Windows, you cannot — use a Mac or CI.

---

### Step 10A — Upload installers to Vercel Blob

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Upload each installer to Blob storage
vercel blob put "agent-setup-windows.exe"  "agent/dist/WorkTrack Agent Setup 1.0.0.exe"
vercel blob put "agent-setup-mac.dmg"      "agent/dist/WorkTrack Agent-1.0.0.dmg"
vercel blob put "agent-linux.AppImage"     "agent/dist/WorkTrack Agent-1.0.0.AppImage"
```

Copy the returned public URLs and add them as env vars in Vercel:
```
NEXT_PUBLIC_AGENT_WINDOWS_DOWNLOAD_URL = https://xxxx.public.blob.vercel-storage.com/agent-setup-windows.exe
NEXT_PUBLIC_AGENT_MAC_URL   = https://xxxx.public.blob.vercel-storage.com/agent-setup-mac.dmg
NEXT_PUBLIC_AGENT_LINUX_URL = https://xxxx.public.blob.vercel-storage.com/agent-linux.AppImage
```

Redeploy Vercel so the Download page shows the real links.

---

### Step 10B — Auto-build with GitHub Actions (recommended)

Create `.github/workflows/build-agent.yml`:

```yaml
name: Build Agent
on:
  push:
    paths: ['agent/**']
    branches: [main]

jobs:
  build:
    strategy:
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd agent && npm install
      - run: cd agent && npm run build
        env:
          WORKTRACK_SERVER: ${{ secrets.NEXT_PUBLIC_APP_URL }}
      - uses: actions/upload-artifact@v4
        with:
          name: agent-${{ matrix.os }}
          path: agent/dist/*.{exe,dmg,AppImage,tar.gz}
```

Add `NEXT_PUBLIC_APP_URL` as a GitHub secret. Every push to `agent/` triggers a build across all 3 platforms automatically.

---

## PART 3 — Roll out to employees (10 min)

### Option A — Share the download link
Send employees to: `https://your-project.vercel.app/download`

They download and install themselves following the on-screen steps.

---

### Option B — Windows: Group Policy (GPO) silent install
```powershell
# Run on each machine or via GPO startup script:
powershell -WindowStyle Hidden -ExecutionPolicy Bypass `
  -Command "& { iwr 'https://your-app.vercel.app/download' -OutFile $env:TEMP\wt.exe; Start-Process $env:TEMP\wt.exe '/S' -Wait }"
```

---

### Option C — Mac: MDM (Jamf / Mosyle / Kandji)
1. Upload the `.pkg` version to your MDM
2. Create a policy to push to all managed Macs
3. Add a script policy to run `install-mac.sh`

---

### Option D — One-liner (IT pastes in terminal)
**Windows PowerShell:**
```powershell
irm https://your-app.vercel.app/api/agent/install.ps1 | iex
```

**Mac/Linux Terminal:**
```bash
curl -fsSL https://your-app.vercel.app/api/agent/install.sh | bash
```

---

## PART 4 — Add employees in the dashboard

1. Login → User Management → **Add User**
2. Fill name, email, role, assign to team
3. Set a temporary password
4. Tell the employee their email + password
5. They open WorkTrack Agent → sign in → tracking starts automatically

---

## Role guide

| Role | Can see | Can do |
|------|---------|--------|
| **Super Admin** | Everything | Create/edit/delete users, all reports, all screenshots |
| **Executive** | Reports & dashboard | Read-only, no live monitor control |
| **QA Manager** | All employees | Live monitor, screenshots, send alerts |
| **Team Lead** | Their team only | Live monitor their team, send alerts to their team |
| **Employee** | Own data only | View own hours + screenshots |

---

## Costs (all free tiers)

| Service | Free tier | Paid if you exceed |
|---------|-----------|-------------------|
| Vercel | 100GB bandwidth/mo | $20/mo Pro |
| Neon | 0.5GB storage, 190hrs compute | $19/mo Launch |
| Pusher | 200k messages/day, 100 connections | $49/mo Startup |
| Vercel Blob | 5GB storage | $0.023/GB after |

For a team of up to ~30 people, **total cost = $0/month**.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Agent can't connect | Check `SERVER_URL` in `agent/src/main.ts` matches your Vercel URL |
| No screenshots appearing | On Mac: grant Screen Recording in System Settings |
| Database errors | Re-run `node scripts/migrate.js` |
| Live monitor not updating | Check Pusher credentials in Vercel env vars |
| "Invalid credentials" | Make sure you ran the migration (creates default admin) |
