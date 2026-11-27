import { modelEvents } from './cds-model-transport';
export { default, WorkspaceDurableObject } from '../../../server/worker';

const network = globalThis.fetch;
globalThis.fetch = async (resource, init) => {
  const address = typeof resource === 'string' || resource instanceof URL ? String(resource) : resource.url;
  if (address !== 'https://cds-model.example/v1/chat/completions') return network(resource, init);
  const body = typeof init?.body === 'string' ? init.body : await new Request(resource, init).text();
  const events = await modelEvents(body);
  return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
};
