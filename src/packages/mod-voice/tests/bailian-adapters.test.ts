import { expect, it, vi } from 'vitest';
import { ParaformerTranscriber, SambertTTSProvider } from '..';

class ScriptedSocket extends EventTarget {
  readonly sent: (string | ArrayBuffer)[] = [];
  readonly close = vi.fn();
  send(frame: string | ArrayBuffer) { this.sent.push(frame); }
  event(event: string, payload = {}, extra = {}) {
    const task = JSON.parse(String(this.sent[0]));
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ header: { task_id: task.header.task_id, event, ...extra }, payload }) }));
  }
}

it('buffers ordered mono PCM until Paraformer starts, separates interim and final sentences, and drains on close', async () => {
  const socket = new ScriptedSocket();
  const connect = vi.fn(async () => socket);
  const onPartial = vi.fn(), onFinal = vi.fn();
  const session = new ParaformerTranscriber('synthetic-token', connect).createSession({ onPartial, onFinal });
  const first = new Int16Array(1600).fill(-45).buffer, second = new Int16Array(1600).fill(17).buffer;
  session.feed(first);
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  expect(connect).toHaveBeenCalledWith('wss://dashscope.aliyuncs.com/api-ws/v1/inference', { Authorization: 'Bearer synthetic-token' }, expect.any(AbortSignal));
  const run = JSON.parse(String(socket.sent[0]));
  expect(run).toMatchObject({ header: { action: 'run-task', streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: 'paraformer-realtime-v2', parameters: { format: 'pcm', sample_rate: 16000, language_hints: ['zh', 'en'], semantic_punctuation_enabled: true } } });
  session.feed(second);
  const drained = session.close();
  expect(socket.sent).toHaveLength(1);
  socket.event('task-started');
  expect(socket.sent.slice(1, 3)).toEqual([first, second]);
  expect(JSON.parse(String(socket.sent[3]))).toMatchObject({ header: { action: 'finish-task', task_id: run.header.task_id } });
  for (const sentence of [{ heartbeat: true }, { sentence_end: false, text: 'Where' }, { sentence_end: true, text: 'Where does it hurt?' }]) socket.event('result-generated', { output: { sentence } });
  expect(onPartial.mock.calls).toEqual([['Where']]);
  expect(onFinal.mock.calls).toEqual([['Where does it hurt?']]);
  expect(socket.close).not.toHaveBeenCalled();
  socket.event('task-finished');
  await drained;
  expect(socket.close).toHaveBeenCalledOnce();
});

function streamedWav() {
  return Uint8Array.from(Buffer.from('52494646bfffff7f57415645666d74201000000001000100803e0000007d000002001000646174619bffff7f0100020003000400', 'hex'));
}
it('returns repaired playable Sambert WAV only after task-finished, without sending finish-task', async () => {
  const socket = new ScriptedSocket();
  const audio = new SambertTTSProvider('synthetic-token', async () => socket).synthesize('Synthetic reply', { voice: 'sambert-zhiqi-v1' });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  expect(JSON.parse(String(socket.sent[0]))).toMatchObject({ header: { action: 'run-task', streaming: 'out' }, payload: { model: 'sambert-zhiqi-v1', task: 'tts', function: 'SpeechSynthesizer', input: { text: 'Synthetic reply' }, parameters: { text_type: 'PlainText', format: 'wav', sample_rate: 16000 } } });
  socket.event('task-started');
  const wav = streamedWav();
  for (const data of [wav.slice(0, 17).buffer, wav.slice(17).buffer]) socket.dispatchEvent(new MessageEvent('message', { data }));
  expect(socket.close).not.toHaveBeenCalled();
  socket.event('task-finished');
  const bytes = new DataView(await audio);
  expect([bytes.getUint32(4, true), bytes.getUint32(40, true), bytes.byteLength]).toEqual([44, 8, 52]);
  expect(new Uint8Array(bytes.buffer, 44)).toEqual(Uint8Array.of(1, 0, 2, 0, 3, 0, 4, 0));
  expect(socket.sent).toHaveLength(1);
});

it('immediately closes streaming synthesis on barge-in and aborts a still-connecting handshake', async () => {
  const socket = new ScriptedSocket();
  const control = new AbortController();
  const audio = new SambertTTSProvider('synthetic-token', async () => socket).synthesize('Synthetic reply', control.signal);
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  socket.event('task-started');
  control.abort();
  expect(socket.close).toHaveBeenCalledOnce();
  await expect(audio).rejects.toMatchObject({ name: 'AbortError' });
  const pending = new AbortController();
  const connect = vi.fn(() => new Promise<ScriptedSocket>(() => {}));
  const connecting = new SambertTTSProvider('synthetic-token', connect).synthesize('Synthetic reply', { signal: pending.signal });
  pending.abort();
  expect(connect).toHaveBeenCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ aborted: true }));
  await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
  expect(socket.sent).toHaveLength(1);
});

it('reports a failed task or unexpected disconnect without echoing a provider message or credential', async () => {
  const socket = new ScriptedSocket();
  const onFatalError = vi.fn();
  const session = new ParaformerTranscriber('synthetic-token', async () => socket).createSession({ onFatalError });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  socket.event('task-failed', {}, { error_code: 'InvalidApiKey', error_message: 'unauthorized synthetic-token' });
  await expect(session.close()).rejects.toThrow('VOICE_AUTH_FAILED');
  expect(onFatalError).toHaveBeenCalledWith(expect.objectContaining({ message: 'VOICE_AUTH_FAILED' }));
  const other = new ScriptedSocket();
  const audio = new SambertTTSProvider('synthetic-token', async () => other).synthesize('Synthetic reply');
  await vi.waitFor(() => expect(other.sent).toHaveLength(1));
  other.dispatchEvent(new Event('close'));
  await expect(audio).rejects.toThrow('VOICE_PROVIDER_FAILED');
});
