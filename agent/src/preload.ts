// agent/src/preload.ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const updaterChannels = [
  'updater:checking',
  'updater:available',
  'updater:not-available',
  'updater:progress',
  'updater:downloaded',
  'updater:error',
] as const;

type UpdaterChannel = typeof updaterChannels[number];

contextBridge.exposeInMainWorld('agent', {
  login:         (email:string,pw:string) => ipcRenderer.invoke('login',email,pw),
  logout:        ()                       => ipcRenderer.invoke('logout'),
  getStatus:     ()                       => ipcRenderer.invoke('get-status'),
  getAlerts:     ()                       => ipcRenderer.invoke('get-alerts'),
  syncAlerts:    ()                       => ipcRenderer.invoke('sync-alerts'),
  markAlertRead: (id:string)             => ipcRenderer.invoke('mark-alert-read', id),
  storeAlert:    (alert:any)             => ipcRenderer.invoke('store-alert', alert),
  manualShot:    ()                       => ipcRenderer.invoke('manual-shot'),
  stopTracking:  ()                       => ipcRenderer.invoke('stop-tracking'),
  startTracking: ()                       => ipcRenderer.invoke('start-tracking'),
  startWork:     ()                       => ipcRenderer.invoke('start-work'),
  startBreak:    ()                       => ipcRenderer.invoke('start-break'),
  endBreak:      ()                       => ipcRenderer.invoke('end-break'),
  checkout:      ()                       => ipcRenderer.invoke('checkout'),
  getDisclosure: ()                       => ipcRenderer.invoke('disclosure:get'),
  acknowledgeDisclosure: ()               => ipcRenderer.invoke('disclosure:ack'),
  updater: {
    getStatus: () => ipcRenderer.invoke('updater:status'),
    check:     () => ipcRenderer.invoke('updater:check'),
    install:   () => ipcRenderer.invoke('updater:install'),
    on:        (channel: UpdaterChannel, cb:(d:any)=>void) => {
      if (!updaterChannels.includes(channel)) {
        throw new Error('Unsupported updater event');
      }
      const listener = (_event: IpcRendererEvent, data:any) => cb(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
  onStatus:      (cb:(d:any)=>void)      => { ipcRenderer.on('status-changed',(_,d)=>cb(d)); },
  onIdle:        (cb:(d:any)=>void)      => { ipcRenderer.on('idle-status',(_,d)=>cb(d)); },
  onAlert:       (cb:(d:any)=>void)      => { ipcRenderer.on('new-alert',(_,d)=>cb(d)); },
});
