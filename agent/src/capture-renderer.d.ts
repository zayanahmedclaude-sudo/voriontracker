export {};
declare global {
  interface Window {
    livePublisher: {
      onStart: (
        cb: (data: {
          sourceId: string;
          employeeId: string;
          sessionId: string;
          authToken: string;
          serverUrl: string;
          quality?: { width: number; height: number; frameRate: number; maxBitrate: number };
        }) => void,
      ) => void;
      onStop: (cb: () => void) => void;
      sendReady: () => void;
      log: (payload: Record<string, unknown>) => void;
    };
  }
}
