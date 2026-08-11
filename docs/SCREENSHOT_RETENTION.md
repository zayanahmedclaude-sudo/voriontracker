# Screenshot Retention

Vorion keeps screenshot metadata for reporting, but regular screenshot storage references expire after 14 elapsed days.

## Automated Database Cleanup

Vercel Cron calls:

```text
GET /api/cron/screenshot-retention
Authorization: Bearer ${CRON_SECRET}
```

The cron schedule in `vercel.json` is `0 2 * * *`, which runs daily at 02:00 UTC, approximately 07:00 Pakistan Standard Time. Vercel Cron runs only against Production deployments.

Set `CRON_SECRET` in Vercel Production environment variables. Do not put it in source control or shell history. The endpoint fails closed if `CRON_SECRET` is missing and does not accept query-string authentication.

The cleanup job:

- Uses the `scheduled_job_leases` database lease table, which is safe with PgBouncer transaction pooling.
- Selects and updates expired rows in bounded batches.
- Sets `storage_expired_at`.
- Clears screenshot URL columns only.
- Preserves complete screenshot rows and reporting metadata.
- Excludes screenshots that have `screenshot_flags` rows.
- Does not delete R2 objects.

Required production environment variables:

```text
CRON_SECRET
MIN_AGENT_PROTOCOL_VERSION=2
AGENT_DOWNLOAD_URL
```

`AGENT_DOWNLOAD_URL` must be a trusted HTTPS update/download location. Protocol failures return only the minimum protocol version and this trusted URL.

## Canonical Screenshot Protocol

Canonical screenshot upload protocol version is `2`.

Agent screenshot requests must send:

```text
X-Vorion-Agent-Protocol: 2
X-Vorion-Agent-Id: <device id>
```

Canonical routes:

```text
POST /api/r2/screenshot-upload-urls
POST /api/agent/screenshots/commit
```

Canonical object keys:

```text
screenshots/regular/default/{employeeId}/{yyyy}/{mm}/{dd}/{captureId}.{ext}
screenshots/thumbnails/default/{employeeId}/{yyyy}/{mm}/{dd}/{captureId}.{ext}
evidence/flagged/default/{employeeId}/{yyyy}/{mm}/{dd}/{flagId-or-screenshotId}.{ext}
```

The current schema does not expose a tenant/organization ID, so `default` is the highest available ownership boundary before `employeeId`.

Rollout order:

1. Deploy backend code that understands protocol 2.
2. Release the new agent that sends protocol 2.
3. Confirm adoption in production.
4. Set `MIN_AGENT_PROTOCOL_VERSION=2` in Production.
5. Confirm old agents receive HTTP 426 `agent_upgrade_required`.
6. Keep legacy screenshot routes as inert tombstones until old traffic is gone, then remove them in a later deployment.

Manual catch-up can be performed by invoking the same route repeatedly with the Bearer secret from a private terminal or trusted HTTP client. Use `?dryRun=true` to return counts without changing rows. Avoid commands that print `CRON_SECRET` to logs.

## Cloudflare R2 Lifecycle Rules

Do not configure these until all release gates below are green. Configure manually:

```text
Cloudflare Dashboard
-> R2
-> Bucket
-> Settings
-> Object lifecycle rules
```

Add 14-day expiration rules for these prefixes:

```text
screenshots/regular/
screenshots/thumbnails/
```

Do not apply lifecycle expiration to:

```text
evidence/flagged/
evidence/documents/
recordings/
live-recordings/
flagged-screenshots/
flag-reports/
unknown legacy prefixes
```

R2 deletion may occur within approximately 24 hours after the configured expiration time. Database reference cleanup and R2 lifecycle deletion are independent processes.

Legacy regular screenshot keys used `screenshots/{employeeId}/...` and thumbnails used `screenshots/{employeeId}/thumbs/...`. Do not configure a broad `screenshots/` lifecycle rule unless all flagged/evidence objects are proven to be outside that prefix.

Lifecycle activation blockers:

- Old agents still uploading legacy keys.
- Protocol 2 adoption incomplete.
- Existing flagged evidence references regular objects instead of `evidence/flagged/`.
- Evidence migration/audit blockers are non-zero.
- Null-safe screenshot UI/API is not deployed.
- Cron lease and retention throughput are not verified on production-like data.

## Expected Volume

At 40 employees capturing every 5 seconds for 9 hours, the system may create about 259,200 screenshot rows per working day. The initial batch size is 5,000 rows and the Vercel route uses a 25 second service budget inside a 30 second function limit.

If one daily invocation cannot clear the daily eligible workload, use one of these options after explicit approval:

- More frequent Vercel Cron on a compatible paid plan.
- A Vercel Workflow/background job.
- A later VPS systemd worker after backend migration.
- Schema separation or partitioning for screenshots.

No VPS, Docker, PostgreSQL server, PgBouncer, LiveKit, DNS, or firewall change is required for this implementation.
