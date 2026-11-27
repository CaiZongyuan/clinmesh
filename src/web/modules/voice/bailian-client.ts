import { permitsProviderKey } from '../../../packages/agent-protocol';
import { voiceServerFrame } from '../../../packages/mod-voice';
import type { MicEvents } from './browser-speech';
import { capturePcm } from './media';

export type Binding = { epoch: string; encounterId: string };
function connect(binding: Binding, first: object, signal: AbortSignal, receive: (frame: ReturnType<typeof voiceServerFrame.parse> | ArrayBuffer) => void, end: (error?: Error) => void) {
  const url = new URL('/api/voice/session', location.href);
  if (!permitsProviderKey(url)) throw Error('VOICE_HTTPS_REQUIRED');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams(binding).toString();
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let settled = false;
  const close = () => { if (socket.readyState < WebSocket.CLOSING) socket.close(); };
  function finish(error?: Error) {
    if (settled) return;
    settled = true; signal.removeEventListener('abort', cancel); close(); end(error);
  }
  const cancel = () => finish();
  signal.addEventListener('abort', cancel, { once: true });
  socket.onopen = () => { if (!settled) socket.send(JSON.stringify(first)); };
  socket.onclose = socket.onerror = () => finish(Error('VOICE_CONNECTION_FAILED'));
  socket.onmessage = event => {
    if (settled) return;
    try {
      if (event.data instanceof ArrayBuffer) { receive(event.data); return; }
      const frame = voiceServerFrame.parse(JSON.parse(event.data));
      if (frame.type === 'error') finish(Error(frame.code));
      else if (frame.type === 'done') finish();
      else receive(frame);
    } catch { finish(Error('VOICE_INVALID_RESPONSE')); }
  };
  return socket;
}

export function bailianMic(binding: Binding, token: string, context: AudioContext, events: MicEvents, signal: AbortSignal) {
  let capture: Promise<() => Promise<void>> | undefined;
  let finishing = false;
  const socket = connect(binding, { type: 'listen', token: token || undefined }, signal, frame => {
    if (frame instanceof ArrayBuffer) throw Error();
    if (frame.type === 'partial') events.partial(frame.text);
    if (frame.type === 'final') events.final(frame.text);
    if (frame.type !== 'listening') return;
    if (finishing) { socket.send(JSON.stringify({ type: 'finish' })); return; }
    capture = capturePcm(context, signal, (pcm, speech) => {
      if (speech) events.speech();
      if (socket.bufferedAmount > 320000) { events.end(Error('VOICE_AUDIO_BACKLOG')); return; }
      if (socket.readyState === WebSocket.OPEN) socket.send(pcm);
    });
    void capture.catch(() => { if (!signal.aborted) events.end(Error('VOICE_MIC_UNAVAILABLE')); });
  }, events.end);
  return () => {
    finishing = true;
    if (capture) void capture.then(async stop => { await stop(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'finish' })); }).catch(() => {});
  };
}

export async function bailianSpeak(binding: Binding, token: string, text: string, context: AudioContext, signal: AbortSignal) {
  const chunks: ArrayBuffer[] = [];
  let length = 0;
  await new Promise<void>((resolve, reject) => {
    connect(binding, { type: 'speak', token: token || undefined, text }, signal, frame => {
      if (!(frame instanceof ArrayBuffer) || (length += frame.byteLength) > 8 * 1024 * 1024) throw Error();
      chunks.push(frame);
    }, error => error ? reject(error) : resolve());
  });
  signal.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
  const buffer = await context.decodeAudioData(bytes.buffer);
  signal.throwIfAborted();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  await new Promise<void>(resolve => {
    const stop = () => source.stop();
    signal.addEventListener('abort', stop, { once: true });
    source.onended = () => { signal.removeEventListener('abort', stop); source.disconnect(); resolve(); };
    source.start();
  });
}
