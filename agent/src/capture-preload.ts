import { contextBridge, ipcRenderer } from 'electron';

console.log('[AGENT] live publisher preload loaded');

contextBridge.exposeInMainWorld('livePublisher', {
  onStart: (
    cb: (data: {
      sourceId: string;
      employeeId: string;
      sessionId: string;
      authToken: string;
      serverUrl: string;
      quality?: { width: number; height: number; frameRate: number; maxBitrate: number };
    }) => void,
  ) => ipcRenderer.on('livekit:start', (_event, data) => cb(data)),
  onStop: (cb: () => void) => ipcRenderer.on('livekit:stop', () => cb()),
  sendReady: () => ipcRenderer.send('livekit:ready'),
  log: (payload: Record<string, unknown>) => ipcRenderer.send('livekit:log', payload),
});
