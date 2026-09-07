# Employee timeline deployment

The timeline now uses one page and one set of date, period, search, status and sort controls. The previous timeline page and its duplicate CSV controls/styles were removed. Admin, superadmin and executive accounts are viewers, never employee rows or notification subjects.

## Database and API

- Apply `migrations/20260907_timeline_features.sql` on the API database before rollout. The API also creates these additive tables lazily for existing installations.
- For an installation migrated from Blob to Cloudflare R2, run `node scripts/migrate-screenshot-r2-url.cjs`. It creates `file_url`, allows old Blob columns to be null, and copies only URLs under the configured R2 origins. It does not import old Blob-provider URLs or delete records. Existing upgraded databases avoid historical backfills on each cold start.
- Deploy both the web app and API; `NEXT_PUBLIC_API_URL` must point at the API deployment containing `/api/timeline`, `/api/timeline/events`, `/api/timeline/export` and `/api/cron/timeline`.

## Delivery worker

Set a strong `CRON_SECRET` on the API and the worker. Existing `SMTP_*` or Gmail settings provide email delivery. Run `node scripts/run-timeline-worker.cjs` as a supervised process, setting `TIMELINE_WORKER_URL` to the API origin, or call `/api/cron/timeline` every minute with `Authorization: Bearer <CRON_SECRET>` from an external scheduler. Do not put this secret in browser environment variables.

The repository's Vercel configuration forwards API traffic to the separate API host, so the worker must target that host. No production email or employee message is sent by the tests. Delivery leases prevent concurrent sends; a provider acceptance followed by a process crash can still produce a duplicate on retry. SMTP does not guarantee exactly-once delivery.

## Employee configuration and agent

Assign actual weekly schedules and optional geofences through the employee Schedule tab. The default editor values are a draft, not an assignment. With an assigned schedule, all checkout/quit attempts before its exact end (including the last 15 minutes) are flagged. Checkout is rejected; quitting is blocked and monitoring remains active. Accounts without an assigned schedule are not blocked based on the reporting window alone.

Rebuild and distribute the desktop agent to enable foreground app usage events, exact idle transitions, check-in location, and close-attempt capture. Events are queued on disk per employee and retried after reconnection. Foreground app open/close labels describe observed usage sessions, not OS process creation/termination. Normal window close-to-tray is not a termination attempt. Supervisor restarts are not falsely labeled as intentional user attempts.

Location depends on OS/browser geolocation availability and permission; a missing or uncertain position is shown explicitly. Check-in is not blocked when location is unavailable. A requested geofence boundary is checked against reported accuracy.

## Retention and verification

Ordinary screenshots retain the existing 14-day policy. The existing flagged-evidence retention exception also protects captures linked to early attempts. Timeline events and notification feed entries expire after 90 days; attendance source records retain their existing policy.

Run `npm test`, the web TypeScript check, and `node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit` from `agent/`. Validate the authenticated UI, SMTP deliveries and supervisor behavior in staging before distributing the agent. Manual CSV/PDF downloads honor the requesting user's employee scope and selected rows.
