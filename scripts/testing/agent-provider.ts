import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

type Script = (request: IncomingMessage, response: ServerResponse, payload: string) => void | Promise<void>;
export async function withProvider(port: number, script: Script, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    await script(request, response, body);
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${port}/v1`); }
  finally { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; }
}
export function openAiText(response: ServerResponse, text: string, finishReason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const common = { id: 'synthetic-response', created: 1800000000, model: 'synthetic-model', object: 'chat.completion.chunk' };
  response.end(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`);
}
export const userProvider = (baseUrl: string, provider = 'openai') => ({ 'X-ClinMesh-LLM-Api-Key': 'synthetic-user-only-key', 'X-ClinMesh-LLM-Model': 'synthetic-model', 'X-ClinMesh-LLM-Provider': provider, 'X-ClinMesh-LLM-Base-Url': baseUrl });
