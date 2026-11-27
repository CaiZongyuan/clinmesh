import { providerError, type BailianConnect } from '../packages/mod-voice';

export const connectWorkerVoice: BailianConnect = async (url, headers, signal) => {
  const endpoint = new URL(url);
  endpoint.protocol = 'https:';
  const response = await fetch(endpoint, { headers: { ...headers, Upgrade: 'websocket' }, redirect: 'manual', signal });
  const socket = response.webSocket;
  if (!socket) throw providerError(String(response.status));
  socket.binaryType = 'arraybuffer';
  socket.accept();
  return socket;
};
