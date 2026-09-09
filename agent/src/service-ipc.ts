import net from 'net';

export const SERVICE_PIPE_NAME = 'vorion-tracker-service';

export type ServiceCommandName =
  | 'ping'
  | 'agent-heartbeat'
  | 'get-device-token'
  | 'queue-upsert'
  | 'queue-list'
  | 'queue-delete'
  | 'begin-update';

export type ServiceCommand =
  | { command: 'ping' }
  | { command: 'agent-heartbeat'; pid: number; sessionId?: string }
  | { command: 'get-device-token'; pid: number }
  | { command: 'queue-upsert'; pid: number; record: unknown }
  | { command: 'queue-list'; pid: number; limit?: number }
  | { command: 'queue-delete'; pid: number; localId: string }
  | { command: 'begin-update'; pid: number };

export type ServiceResponse = {
  ok: boolean;
  result?: any;
  error?: string;
};

type ServiceRequestEnvelope = {
  id: string;
  payload: ServiceCommand;
};

type ServiceResponseEnvelope = {
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
};

export function getServicePipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${SERVICE_PIPE_NAME}`
    : `/tmp/${SERVICE_PIPE_NAME}.sock`;
}

// The supervisor accepts one connection at a time. Serialize requests here
// instead of racing screenshot writes against heartbeat/enrollment connections.
const pendingCommands: Array<{ command: ServiceCommand; run: () => Promise<void> }> = [];
let commandInFlight = false;

export function sendServiceCommand(command: ServiceCommand, timeoutMs = 5000): Promise<ServiceResponse> {
  return new Promise((resolve, reject) => {
    pendingCommands.push({ command, run: async () => {
      try { resolve(await executeServiceCommand(command, timeoutMs)); }
      catch (error) { reject(error); }
    } });
    void drainServiceCommands();
  });
}

async function drainServiceCommands() {
  if (commandInFlight) return;
  commandInFlight = true;
  try {
    while (pendingCommands.length) {
      const priorityIndex = pendingCommands.findIndex(item => item.command.command === 'agent-heartbeat' || item.command.command === 'begin-update');
      const [next] = pendingCommands.splice(priorityIndex < 0 ? 0 : priorityIndex, 1);
      await next.run();
    }
  } finally { commandInFlight = false; }
}

async function executeServiceCommand(command: ServiceCommand, timeoutMs: number): Promise<ServiceResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getServicePipePath());
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let buffer = '';
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      // Destroy timed-out sockets so a stalled request cannot occupy the pipe.
      socket.on('error', () => {});
      socket.destroy();
      callback();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error('Service IPC request timed out')));
    }, timeoutMs);

    socket.setEncoding('utf8');

    socket.on('connect', () => {
      const envelope: ServiceRequestEnvelope = { id: requestId, payload: command };
      socket.write(`${JSON.stringify(envelope)}\n`);
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
          newlineIndex = buffer.indexOf('\n');
          continue;
        }
        try {
          const response = JSON.parse(line) as ServiceResponseEnvelope;
          if (response.id !== requestId) {
            newlineIndex = buffer.indexOf('\n');
            continue;
          }
          finish(() => resolve({ ok: response.ok, result: response.result, error: response.error }));
          return;
        } catch (error) {
          finish(() => reject(error));
          return;
        }
      newlineIndex = buffer.indexOf('\n');
      }
    });

    socket.on('error', (error) => {
      finish(() => reject(error));
    });

    socket.on('end', () => {
      if (!settled) {
        finish(() => reject(new Error('Service IPC connection ended before a response was received')));
      }
    });
  });
}
