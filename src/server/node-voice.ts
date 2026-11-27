import { WebSocket, type RawData } from 'ws';
import { providerError, type BailianConnect } from '../packages/mod-voice';

function binary(data: RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return Uint8Array.from(Array.isArray(data) ? Buffer.concat(data) : data).buffer;
}

export const connectNodeVoice: BailianConnect = (url, headers, signal) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10000 });
  const events = new EventTarget();
  const abort = () => ws.terminate();
  ws.binaryType = 'arraybuffer';
  ws.on('message', (data, isBinary) => events.dispatchEvent(new MessageEvent('message', { data: isBinary ? binary(data) : data.toString() })));
  ws.on('error', () => { reject(providerError()); events.dispatchEvent(new Event('error')); });
  ws.once('unexpected-response', (_, response) => { reject(providerError(String(response.statusCode))); response.destroy(); ws.terminate(); });
  ws.once('close', () => { signal.removeEventListener('abort', abort); reject(providerError()); events.dispatchEvent(new Event('close')); });
  ws.once('open', () => resolve(Object.assign(events, { send: (data: string | ArrayBuffer) => ws.send(data), close: () => ws.close() })));
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});
