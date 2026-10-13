import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
type Event = { key: string; employee: string; type: string; app: string; durationMinutes: number; activityPct: number; at: string };

// Durable outbox for timeline events. File names carry the event time and the
// employee (`<ms>_<employee>_<key>.json`) so a flush can pick the oldest events
// for the signed-in employee without reading every file.
//
// Writing an event never waits for a flush: checkout and logout record their
// final events while a large backlog is still being delivered.
const NAME = /^(\d{13})_([A-Za-z0-9-]+)_([A-Za-z0-9-]+)\.json$/;
const LEGACY_NAME = /^[a-f0-9-]{36}\.json$/;
const BATCH_SIZE = 200;
const SEND_CONCURRENCY = 4;
// The server will never accept these; retrying them blocked the queue forever.
const PERMANENT_STATUSES = new Set([400, 403, 409, 422]);

function fileName(event: Event) {
  const ms = Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : Date.now();
  return `${String(ms).padStart(13, '0')}_${event.employee || 'none'}_${event.key}.json`;
}

export class TimelineEventQueue {
  private flushing: Promise<number> | null = null;
  constructor(private directory: string) {}

  async enqueue(employee:string,type:string,app:string,durationMinutes:number,activityPct:number,at=new Date().toISOString()) {
    const event:Event={key:randomUUID(),employee,type,app,durationMinutes,activityPct,at};
    await fs.mkdir(this.directory,{recursive:true});
    const file=path.join(this.directory,fileName(event));
    await fs.writeFile(`${file}.tmp`,JSON.stringify(event),{mode:0o600});
    await fs.rename(`${file}.tmp`,file);
  }

  // Concurrent callers share the running flush instead of queueing new ones.
  // Resolves with the number of events handled (sent or set aside).
  flush(employee:string,send:(event:Event)=>Promise<unknown>) {
    if (!this.flushing) {
      this.flushing = this.flushOnce(employee, send).finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }

  private async flushOnce(employee:string,send:(event:Event)=>Promise<unknown>) {
    await fs.mkdir(this.directory,{recursive:true});
    await this.migrateLegacyFiles();
    const names=(await fs.readdir(this.directory))
      .filter(name=>{ const match=NAME.exec(name); return Boolean(match && match[2]===employee); })
      .sort()
      .slice(0,BATCH_SIZE);

    let stopError: unknown = null;
    let next = 0;
    let handled = 0;
    const worker = async () => {
      while (!stopError && next < names.length) {
        const name = names[next++];
        const file = path.join(this.directory, name);
        let event: Event;
        try { event = JSON.parse(await fs.readFile(file,'utf8')); }
        catch { await fs.rename(file, `${file}.rejected`).catch(() => undefined); continue; }
        try { await send(event); }
        catch (error: any) {
          if (PERMANENT_STATUSES.has(error?.status)) {
            // Keep permanently refused records for diagnosis without blocking sync.
            await fs.rename(file, `${file}.rejected`).catch(() => undefined);
            handled += 1;
            continue;
          }
          stopError = error; // Authentication and network failures stop this flush.
          return;
        }
        await fs.unlink(file).catch(() => undefined);
        handled += 1;
      }
    };
    await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
    if (stopError) throw stopError;
    return handled;
  }

  // Older agents named files by key only; rename them once so later flushes
  // can select by name. Events without an employee can never be delivered.
  private async migrateLegacyFiles() {
    const legacy=(await fs.readdir(this.directory)).filter(name=>LEGACY_NAME.test(name));
    for (const name of legacy) {
      const file=path.join(this.directory,name);
      try {
        const event: Event = JSON.parse(await fs.readFile(file,'utf8'));
        if (!event.employee) { await fs.rename(file, `${file}.rejected`); continue; }
        await fs.rename(file, path.join(this.directory, fileName(event)));
      } catch {
        await fs.rename(file, `${file}.rejected`).catch(() => undefined);
      }
    }
  }
}
