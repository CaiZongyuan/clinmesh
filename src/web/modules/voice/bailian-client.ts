import { permitsProviderKey } from '../../../packages/agent-protocol';
import { voiceProtocols, voiceServerFrame } from '../../../packages/mod-voice';
import type { MicEvents } from './browser-speech';
import { capturePcm } from './media';

export type Binding = { epoch: string; encounterId: string };
function connect(binding: Binding, token: string, first: object, signal: AbortSignal, receive: (frame: ReturnType<typeof voiceServerFrame.parse> | ArrayBuffer) => void, end: (error?: Error) => void) {
  const url = new URL('/api/voice/session', location.href);
  if (!permitsProviderKey(url)) throw Error('VOICE_HTTPS_REQUIRED');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams(binding).toString();
  const socket = new WebSocket(url, voiceProtocols(token));
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
      if (frame.type === 'error') finish(Error(frame.message));
      else if (frame.type === 'done') finish();
      else receive(frame);
    } catch { finish(Error('VOICE_INVALID_RESPONSE')); }
  };
  return socket;
}

export function bailianMic(binding: Binding, token: string, context: AudioContext, events: MicEvents, signal: AbortSignal) {
  const buffered: ArrayBuffer[] = [];
  let queuedBytes = 0, listening = false, drained = false;
  const socket = connect(binding, token, { type: 'start_call' }, signal, frame => {
    if (frame instanceof ArrayBuffer) throw Error();
    if (frame.type === 'transcript_interim') events.partial(frame.text);
    if (frame.type === 'transcript') events.final(frame.text);
    if (frame.type !== 'status') return;
    if (frame.status === 'idle') { if (listening && drained) events.end(); return; }
    listening = true;
    for (const pcm of buffered) socket.send(pcm);
    buffered.length = 0; queuedBytes = 0;
    if (drained) finishCall();
  }, events.end);
  const finishCall = () => { if (!signal.aborted && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'end_call' })); };
  const capture = capturePcm(context, signal, (pcm, speech) => {
    if (signal.aborted || drained) return;
    if (speech) events.speech();
    if (pcm.byteLength + queuedBytes + socket.bufferedAmount > 320000) { events.end(Error('VOICE_AUDIO_BACKLOG')); return; }
    if (listening) socket.send(pcm);
    else { queuedBytes += pcm.byteLength; buffered.push(pcm); }
  });
  void capture.ready.then(() => { if (!signal.aborted) events.ready(); }, () => { if (!signal.aborted) events.end(Error('VOICE_MIC_UNAVAILABLE')); });
  return () => {
    void capture.finish().then(() => { drained = true; if (listening) finishCall(); }, error => events.end(error));
  };
}

export async function bailianSpeak(binding: Binding, token: string, text: string, context: AudioContext, signal: AbortSignal) {
  const chunks: ArrayBuffer[] = [];
  let length = 0;
  await new Promise<void>((resolve, reject) => {
    connect(binding, token, { type: 'speak', text }, signal, frame => {
      if (!(frame instanceof ArrayBuffer) && (frame.type === 'welcome' || frame.type === 'status')) return;
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
