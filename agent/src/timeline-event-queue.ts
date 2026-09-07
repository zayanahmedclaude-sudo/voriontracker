import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
type Event = { key: string; employee: string; type: string; app: string; durationMinutes: number; activityPct: number; at: string };
export class TimelineEventQueue {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  enqueue(employee:string,type:string,app:string,durationMinutes:number,activityPct:number,at=new Date().toISOString()) {
    const event:Event={key:randomUUID(),employee,type,app,durationMinutes,activityPct,at};
    return this.run(async()=>{await fs.mkdir(this.directory,{recursive:true});const file=path.join(this.directory,`${event.key}.json`);await fs.writeFile(`${file}.tmp`,JSON.stringify(event),{mode:0o600});await fs.rename(`${file}.tmp`,file);});
  }
  flush(employee:string,send:(event:Event)=>Promise<unknown>) {
    return this.run(async()=>{
      await fs.mkdir(this.directory,{recursive:true});
      const files=(await fs.readdir(this.directory)).filter(f=>/^[a-f0-9-]+\.json$/.test(f));
      const events: Array<{file:string;event:Event}>=[];
      for(const file of files){try{const event=JSON.parse(await fs.readFile(path.join(this.directory,file),'utf8'));if(event.employee===employee)events.push({file,event});}catch{/* Keep corrupt files for diagnosis. */}}
      events.sort((a,b)=>a.event.at.localeCompare(b.event.at));
      for(const {file,event} of events.slice(0,100)){await send(event);await fs.unlink(path.join(this.directory,file));}
    });
  }
  private run(task:()=>Promise<void>){const next=this.serial.then(task);this.serial=next.catch(()=>undefined);return next;}
}
