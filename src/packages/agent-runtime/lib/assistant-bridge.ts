import { assistantBrowserFrame, type AssistantChannel, type AssistantFrame, type BrowserRequest } from '../../agent-protocol';
import { CoreError } from '../../platform';

export type AssistantSocket = { send(data: string): void; close(code: number): void };
const offline = () => new CoreError(409, 'ASSISTANT_BRIDGE_DISCONNECTED');
const identity = (channel: AssistantChannel) => JSON.stringify([channel.workspaceId, channel.epoch, channel.encounterId, channel.roleId, channel.thread, channel.clientId]);
export class AssistantBridge {
  private readonly clients = new Map<string, ReturnType<typeof browserConnection>>();
  connect(channel: AssistantChannel, socket: AssistantSocket) {
    const key = identity(channel);
    this.clients.get(key)?.close();
    const connection = browserConnection(socket, () => { if (this.clients.get(key) === connection) this.clients.delete(key); });
    this.clients.set(key, connection);
    connection.emit({ type: 'ready' });
    return connection;
  }
  get(channel: AssistantChannel) {
    const client = this.clients.get(identity(channel));
    if (!client) throw offline();
    return client;
  }
}
function browserConnection(socket: AssistantSocket, release: () => void) {
  const waiting = new Map<string, (value?: unknown) => void>();
  let fields: string[] = [];
  const emit = (frame: AssistantFrame) => socket.send(JSON.stringify(frame));
  function close() { release(); for (const settle of waiting.values()) settle(); waiting.clear(); socket.close(1000); }
  return { emit, close, fields: () => fields,
    receive(raw: unknown) {
      try {
        if (typeof raw !== 'string' || raw.length > 65536) return close();
        const frame = assistantBrowserFrame.parse(JSON.parse(raw));
        if (frame.type === 'protected') fields = frame.fields;
        else waiting.get(frame.id)?.(frame.result);
      } catch { close(); }
    },
    call(request: BrowserRequest, signal: AbortSignal, commandToken?: string) {
      if (signal.aborted) throw offline();
      const id = crypto.randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => finish(), 120000);
        const abort = () => { emit({ type: 'cancel' }); finish(); };
        const finish = (value?: unknown) => { clearTimeout(timeout); signal.removeEventListener('abort', abort); waiting.delete(id); if (value === undefined) reject(offline()); else resolve(value); };
        waiting.set(id, finish); signal.addEventListener('abort', abort, { once: true });
        try { emit({ type: 'call', id, request, commandToken }); } catch { finish(); }
      });
    },
  };
}
