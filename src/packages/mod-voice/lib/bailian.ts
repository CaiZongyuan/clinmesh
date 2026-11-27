import { z } from 'zod';

export type BailianSocket = EventTarget & { send(data: string | ArrayBuffer): void; close(): void };
export type BailianConnect = (url: string, headers: { Authorization: string }, signal: AbortSignal) => Promise<BailianSocket>;
const endpoint = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const eventSchema = z.object({ header: z.object({ task_id: z.string(), event: z.enum(['task-started', 'result-generated', 'task-finished', 'task-failed']), error_code: z.string().optional() }), payload: z.unknown().optional() });
export function providerError(code = '') {
  if (/auth|api.?key|forbidden|^40[13]$/i.test(code)) return Error('VOICE_AUTH_FAILED');
  if (/quota|throttl|limit|^429$/i.test(code)) return Error('VOICE_RATE_LIMITED');
  return Error('VOICE_PROVIDER_FAILED');
}

export function bailianTask(token: string, connect: BailianConnect, streaming: 'duplex' | 'out', payload: object, signal: AbortSignal | undefined, callbacks: {
  started?(): void; result?(payload: unknown): void; binary?(frame: ArrayBuffer): void; finished?(): void;
}) {
  const taskId = crypto.randomUUID();
  const transport = new AbortController();
  let socket: BailianSocket | undefined;
  let started = false, settled = false;
  let resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const abort = () => end(new DOMException('Voice session interrupted', 'AbortError'));
  let timeout = setTimeout(() => end(Error('VOICE_TIMEOUT')), 10000);
  function deadline(ms: number) { clearTimeout(timeout); timeout = setTimeout(() => end(Error('VOICE_TIMEOUT')), ms); }
  function end(error?: Error) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    if (error || !socket) transport.abort();
    socket?.close();
    if (error) reject(error); else resolve();
  }
  function send(frame: string | ArrayBuffer) {
    if (settled) return;
    try { socket!.send(frame); } catch { end(providerError()); }
  }
  function command(action: 'run-task' | 'finish-task', body: object) {
    send(JSON.stringify({ header: { action, task_id: taskId, streaming }, payload: body }));
  }
  function message(event: Event) {
    if (settled) return;
    try {
      const frame: unknown = (event as MessageEvent).data;
      if (frame instanceof ArrayBuffer && started && callbacks.binary) return callbacks.binary(frame);
      if (typeof frame !== 'string' || frame.length > 65536) throw Error();
      const { header, payload } = eventSchema.parse(JSON.parse(frame));
      if (header.task_id !== taskId) throw Error();
      if (header.event === 'task-failed') return end(providerError(header.error_code));
      if (header.event === 'task-started' && !started) { started = true; clearTimeout(timeout); callbacks.started?.(); return; }
      if (!started) throw Error();
      if (header.event === 'result-generated') callbacks.result?.(payload);
      else if (header.event === 'task-finished') { callbacks.finished?.(); end(); }
      else throw Error();
    } catch { end(Error('VOICE_INVALID_RESPONSE')); }
  }
  if (signal?.aborted) abort();
  else {
    signal?.addEventListener('abort', abort, { once: true });
    void connect(endpoint, { Authorization: `Bearer ${token}` }, transport.signal).then(open => {
      if (settled) { open.close(); return; }
      socket = open;
      open.addEventListener('message', message);
      open.addEventListener('error', () => end(providerError()));
      open.addEventListener('close', () => end(providerError()));
      command('run-task', payload);
    }, error => end(error instanceof Error && ['VOICE_AUTH_FAILED', 'VOICE_RATE_LIMITED'].includes(error.message) ? error : providerError()));
  }
  return { done, send, end, deadline, finish: () => command('finish-task', { input: {} }) };
}
