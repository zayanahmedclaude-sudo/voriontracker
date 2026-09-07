# WorkTrack — Deployment Verification Checklist
*Last Updated: 2025*

## Phase 1: Pre-Deployment Validation ✅

### Backend Services
- [ ] **Supabase Project Created**
  - [ ] Auth enabled with email providers
  - [ ] PostgreSQL database accessible
  - [ ] Run `scripts/migrate.js` — verify all tables exist
  - [ ] Tables present: `sessions`, `attendance`, `breaks`, `screenshots`, `recordings`, `employee_status`, `activity_events`, `alerts`, `profiles`
  - [ ] Test admin account: `admin@company.com` / `admin123`

- [ ] **Socket.IO Relay Server**
  - [ ] Running on port 4000: `node server/socket-server.js`
  - [ ] Accessible from Vercel app: test `/api/sessions` creates entry
  - [ ] Broadcasting events: `employee-status`, `heartbeat`

- [ ] **Vercel Deployment**
  - [ ] All env vars set: `DATABASE_URL`, `JWT_SECRET`, `PUSHER_*`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`
  - [ ] Dashboard builds without errors: `npm run build`
  - [ ] Health check: `curl https://YOUR-APP.vercel.app/api/auth` returns 401 (expected)

### Desktop Agent
- [ ] **Agent Builds Successfully**
  ```bash
  cd agent && npm run build
  ```
  - [ ] Output: 103+ artifacts in `agent/dist/`
  - [ ] TypeScript compilation: `npx tsc --noEmit` passes (exit code 0)

- [ ] **Agent Configuration**
  - [ ] `agent/src/main.ts`: `SERVER_URL` points to your Vercel app
  - [ ] `agent/src/preload.ts`: All IPC handlers exported
  - [ ] `agent/src/renderer/App.tsx`: Login form, dashboard UI render correctly

### Frontend Dashboard
- [ ] **TypeScript Validation**
  ```bash
  npx tsc --noEmit
  ```
  - [ ] Zero errors in app/ folder
  - [ ] All imports resolve
  - [ ] Time formatting utilities present: `app/(dashboard)/dashboard/timeUtils.ts`

- [ ] **Time Formatting Features**
  - [ ] Toggle switch in dashboard page shows "Precise" vs "Compact"
  - [ ] Hours column formats as `H:MM` (compact) or `H:MM:SS` (precise)
  - [ ] Last Active shows relative time on hover: "5m ago", "2h ago"

- [ ] **Real-Time Features**
  - [ ] Live monitor page connects to Socket.IO
  - [ ] Supabase realtime subscriptions active
  - [ ] Agent cards update on status changes

---

## Phase 2: Integration Testing

### Authentication Flow
- [ ] Desktop agent login page loads
- [ ] Login with valid email/password succeeds
- [ ] Token stored in `~/.worktrack/token.json`
- [ ] Token refreshed on app restart
- [ ] Logout clears token and session
- [ ] Invalid credentials show error message

### Session Lifecycle
- [ ] "Start Work" button creates session in DB
- [ ] Elapsed time timer starts
- [ ] "Start Break" marks status as `break`
- [ ] "End Break" resumes work
- [ ] "Checkout" ends session and marks attendance complete
- [ ] Dashboard shows correct hours (sum of work + breaks)

### Screenshot & Recording
- [ ] "Capture Screenshot" uploads to Supabase storage
- [ ] File appears in dashboard → Screenshots page
- [ ] Admin can delete screenshot
- [ ] Recording upload works (if enabled)
- [ ] No orphaned files in storage after deletion

### Real-Time Sync
- [ ] Agent status change broadcasts to live monitor within 1 second
- [ ] Multiple agents' status updates don't conflict
- [ ] Dashboard last-active timestamp accurate to ±1 second
- [ ] Stale sessions don't block new logins

### User Management
- [ ] Admins can view all employees
- [ ] Superadmins can delete users
- [ ] User deletion cascades: removes sessions, attendance, breaks, screenshots, alerts, profiles
- [ ] No orphaned records after deletion (verify with `SELECT COUNT(*) FROM sessions WHERE user_id = DELETED_ID`)

---

## Phase 3: Deployment Readiness

### Windows Agent Installer
- [ ] Script located: `agent/scripts/install-windows.ps1`
- [ ] Can run silently: `powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File install-windows.ps1`
- [ ] Registry auto-start configured: `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\WorkTrackAgent`
- [ ] Uninstall works: `-Uninstall` flag removes app + registry entry
- [ ] Tested on: Windows 10 21H2+, Windows 11

### macOS & Linux Scripts
- [ ] `agent/scripts/install-mac.sh` executable and tested
- [ ] `agent/scripts/install-linux.sh` executable and tested
- [ ] All three scripts pass `$WORKTRACK_SERVER` environment variable
- [ ] Silent installation supported for MDM/Intune

### Environment Variables
**Dashboard (Vercel):**
```
DATABASE_URL              = postgresql://...
JWT_SECRET                = [random base64]
R2_ACCOUNT_ID             = [Cloudflare account ID]
R2_ACCESS_KEY_ID          = [R2 API token access key]
R2_SECRET_ACCESS_KEY      = [R2 API token secret]
R2_BUCKET_NAME            = [R2 bucket]
R2_PUBLIC_URL             = [R2 custom/public domain]
PUSHER_APP_ID             = [from pusher.com]
PUSHER_KEY                = [from pusher.com]
PUSHER_SECRET             = [from pusher.com]
PUSHER_CLUSTER            = ap2
NEXT_PUBLIC_PUSHER_KEY    = [same as PUSHER_KEY]
NEXT_PUBLIC_PUSHER_CLUSTER= ap2
NEXT_PUBLIC_APP_URL       = https://YOUR-APP.vercel.app
```

**Desktop Agent (at runtime):**
```
WORKTRACK_SERVER          = https://YOUR-APP.vercel.app
NODE_ENV                  = production
```

---

## Phase 4: Production Hardening

### Security Checklist
- [ ] JWT_SECRET is cryptographically random (32+ bytes)
- [ ] Database backups enabled (Neon → Backups tab)
- [ ] Supabase row-level security reviewed
  - [ ] `profiles` table: users can only read own profile
  - [ ] `sessions` table: users can only read own sessions
  - [ ] Screenshots: users cannot delete others' (admins can)
- [ ] Admin password changed from default `admin123`
- [ ] CORS configured (if API accessed from other origins)

### Monitoring & Logging
- [ ] Vercel logs monitored: `Deployments → [latest] → Logs`
- [ ] Error tracking enabled: Sentry or equivalent
- [ ] Database slow-query logging enabled (Neon)
- [ ] Socket.IO server logs connected/disconnected agents
- [ ] Daily health check: verify `/api/auth` is accessible

### Performance Tuning
- [ ] Database indexes verified:
  ```sql
  SELECT * FROM pg_indexes WHERE tablename IN ('sessions', 'attendance', 'screenshots');
  ```
- [ ] Vercel function timeout set to 30s for `/api/**` routes
- [ ] Socket.IO connection pooling configured (if scaling)
- [ ] Cloudflare R2 bucket and public/custom domain configured

---

## Phase 5: Rollout Plan

### Pilot Group (Week 1)
- [ ] Deploy to 5-10 internal test users
- [ ] Verify desktop agent installs silently
- [ ] Test full session → screenshot → dashboard workflow
- [ ] Capture feedback on UX

### Gradual Rollout (Week 2-3)
- [ ] Deploy to 25% of org (pilot success criteria met)
- [ ] Monitor for issues: check Vercel logs every 4 hours
- [ ] Expand to 50% if no critical bugs
- [ ] Prepare IT support materials

### Full Production (Week 4+)
- [ ] Deploy to remaining 100%
- [ ] Have IT team on standby for support
- [ ] Create internal wiki/FAQ for employees
- [ ] Schedule kickoff meeting with team leads

---

## Post-Deployment

### 30-Day Check-In
- [ ] All employees can login and see correct hours
- [ ] No unresolved critical bugs
- [ ] Performance stable (Vercel dashboard shows green)
- [ ] Collect feedback for Phase 2 features

### Continuous Improvement
- [ ] Monitor Vercel logs for errors
- [ ] Track database query performance
- [ ] Plan feature requests from user feedback
- [ ] Schedule quarterly security review

---

## Support Contacts

| Service | Contact |
|---------|---------|
| Vercel | vercel.com/support (Pro plan required) |
| Supabase | supabase.com/support |
| Neon | neon.tech/support (free tier has community support) |
| Pusher | pusher.com/support |

---

## Troubleshooting Reference

**Desktop agent can't connect to server:**
```powershell
# Check network connectivity
Test-NetConnection -ComputerName your-app.vercel.app -Port 443

# Check token file
Get-Content "$env:USERPROFILE\.worktrack\token.json"

# Restart socket server
node server/socket-server.js
```

**Screenshots not uploading:**
- [ ] Check Cloudflare R2 credentials and bucket name
- [ ] Verify `R2_PUBLIC_URL` points to the configured R2 domain
- [ ] Check browser console for CORS errors

**Dashboard showing wrong hours:**
- [ ] Verify server time and agent time are in sync
- [ ] Check database for overlapping sessions
- [ ] Query: `SELECT user_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 5;`

**Agent install fails on Windows:**
```powershell
# Run as Administrator
# Check logs in: $env:TEMP\WorkTrackInstall.log
# Verify no other instance running: tasklist | findstr WorkTrack
```

---

*Document Version: 1.0*  
*Last Verified: 2025*  
*Next Review: 2025 (or 30 days post-launch)*
