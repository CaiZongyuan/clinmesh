import { assistantServerFrame, type AssistantChannel, type AssistantFrame } from '../packages/agent-protocol';
import type { AssistantSurface } from './assistant-surface';

export function openAssistantChannel(binding: AssistantChannel, surface: AssistantSurface, status: (ready: boolean) => void, update: (frame: Extract<AssistantFrame, { type: 'delta' }>) => void) {
  let active = true;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let turn = new AbortController();
  const protectedFields = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'protected', fields: surface.state.getState().protected })); };
  const unsubscribe = surface.state.subscribe((state, previous) => { if (state.protected !== previous.protected) protectedFields(); });
  function connect() {
    const url = new URL('/api/assistant/bridge', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [key, value] of Object.entries(binding)) url.searchParams.set(key, String(value));
    const client = new WebSocket(url);
    socket = client;
    client.onmessage = async event => {
      if (!active || socket !== client || typeof event.data !== 'string') return;
      try {
        const frame = assistantServerFrame.parse(JSON.parse(event.data));
        if (frame.type === 'ready') { attempts = 0; status(true); protectedFields(); }
        if (frame.type === 'delta') update(frame);
        if (frame.type === 'cancel') { turn.abort(); turn = new AbortController(); }
        if (frame.type === 'call') {
          const result = await surface.call(frame.request, turn.signal);
          if (active && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'result', id: frame.id, result }));
        }
      } catch { client.close(); }
    };
    client.onclose = () => { turn.abort(); turn = new AbortController(); if (active) { status(false); retry = setTimeout(connect, Math.min(8000, 250 * 2 ** attempts++)); } };
  }
  connect();
  return () => { active = false; clearTimeout(retry); turn.abort(); unsubscribe(); socket?.close(); };
}

export function createAmbientQueue(deliver: (events: string[]) => Promise<void>, delay = 1200) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let blocked = false;
  let draining = false;
  let enabled = true;
  function schedule() {
    clearTimeout(timer);
    if (!enabled || blocked || draining || !pending.size) return;
    timer = setTimeout(() => {
      draining = true;
      const batch: string[] = [];
      let length = 0;
      for (const event of pending) {
        if (batch.length && length + event.length > 10500) break;
        pending.delete(event); batch.push(event); length += event.length + 1;
      }
      void deliver(batch).finally(() => { draining = false; schedule(); });
    }, delay);
  }
  return { add(events: string[]) { if (events.length) { for (const event of events) pending.add(event); schedule(); } }, busy(value: boolean) { blocked = value; schedule(); }, close() { enabled = false; clearTimeout(timer); pending.clear(); } };
}
