import fs from 'fs';
import net from 'net';

export const SERVICE_PIPE_NAME = 'vorion-tracker-service';

export type ServiceCommandName =
  | 'ping'
  | 'get-status'
  | 'login'
  | 'logout'
  | 'start-work'
  | 'start-break'
  | 'end-break'
  | 'checkout';

export type ServiceCommand =
  | { command: 'ping' }
  | { command: 'get-status' }
  | { command: 'login'; email: string; password: string }
  | { command: 'logout' }
  | { command: 'start-work' }
  | { command: 'start-break' }
  | { command: 'end-break' }
  | { command: 'checkout' };

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

export async function isServiceReachable(timeoutMs = 800) {
  try {
    const response = await sendServiceCommand({ command: 'ping' }, timeoutMs);
    return Boolean(response.ok);
  } catch {
    return false;
  }
}

export async function sendServiceCommand(command: ServiceCommand, timeoutMs = 5000): Promise<ServiceResponse> {
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
      try { socket.end(); } catch {}
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

export async function startServiceCommandServer(
  handler: (command: ServiceCommand) => Promise<any>,
) {
  const pipePath = getServicePipePath();

  if (process.platform !== 'win32') {
    try { fs.unlinkSync(pipePath); } catch {}
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', async (chunk: string) => {
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
          const envelope = JSON.parse(line) as ServiceRequestEnvelope;
          const result = await handler(envelope.payload);
          const response: ServiceResponseEnvelope = { id: envelope.id, ok: true, result };
          socket.write(`${JSON.stringify(response)}\n`);
        } catch (error: any) {
          const parsed = safeParseRequestEnvelope(line);
          const response: ServiceResponseEnvelope = {
            id: parsed?.id || 'unknown',
            ok: false,
            error: error?.message || 'Service command failed',
          };
          socket.write(`${JSON.stringify(response)}\n`);
        }

        newlineIndex = buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => resolve());
  });

  return server;
}

function safeParseRequestEnvelope(line: string) {
  try {
    return JSON.parse(line) as ServiceRequestEnvelope;
  } catch {
    return null;
  }
}
