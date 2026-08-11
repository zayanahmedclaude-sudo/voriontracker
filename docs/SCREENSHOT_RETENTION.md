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

- Uses a PostgreSQL advisory lock.
- Selects and updates expired rows in bounded batches.
- Sets `storage_expired_at`.
- Clears screenshot URL columns only.
- Preserves complete screenshot rows and reporting metadata.
- Excludes screenshots that have `screenshot_flags` rows.
- Does not delete R2 objects.

Manual catch-up can be performed by invoking the same route repeatedly with the Bearer secret from a private terminal or trusted HTTP client. Use `?dryRun=true` to return counts without changing rows. Avoid commands that print `CRON_SECRET` to logs.

## Cloudflare R2 Lifecycle Rules

Configure these manually:

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

## Expected Volume

At 40 employees capturing every 5 seconds for 9 hours, the system may create about 259,200 screenshot rows per working day. The initial batch size is 5,000 rows and the Vercel route uses a 25 second service budget inside a 30 second function limit.

If one daily invocation cannot clear the daily eligible workload, use one of these options after explicit approval:

- More frequent Vercel Cron on a compatible paid plan.
- A Vercel Workflow/background job.
- A later VPS systemd worker after backend migration.
- Schema separation or partitioning for screenshots.

No VPS, Docker, PostgreSQL server, PgBouncer, LiveKit, DNS, or firewall change is required for this implementation.
