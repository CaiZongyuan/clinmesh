import { scriptedBailian } from './voice-provider';
export { default, WorkspaceDurableObject } from '../worker';

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  if (request.url !== 'https://dashscope.aliyuncs.com/api-ws/v1/inference') return fetchOriginal(input, init);
  if (request.headers.get('upgrade') !== 'websocket') return Promise.resolve(new Response(null, { status: 426 }));
  const pair = new WebSocketPair();
  const upstream = pair[1];
  upstream.binaryType = 'arraybuffer'; upstream.accept();
  const reply = scriptedBailian(request.headers.get('Authorization') ?? undefined, frame => upstream.send(frame));
  upstream.addEventListener('message', event => reply(event.data));
  return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
};
