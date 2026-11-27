import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { operationRequest, type Operation } from '../packages/operation-catalog';
import { CliError } from './errors';

const configuration = z.strictObject({ serverUrl: z.url(), token: z.string().min(1).max(2048).regex(/^[\w.-]+$/) });
async function connection() {
  try {
    const { CLINMESH_SERVER_URL: serverUrl, CLINMESH_TOKEN: token } = process.env;
    const config = configuration.parse(serverUrl !== undefined || token !== undefined ? { serverUrl, token } : JSON.parse(await readFile(join(homedir(), '.clinmesh', 'config.json'), 'utf8')));
    const url = new URL(config.serverUrl);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw Error();
    return { origin: url.origin, token: config.token };
  } catch { throw new CliError('configuration', 'INVALID_CONFIGURATION', 'Set CLINMESH_SERVER_URL and CLINMESH_TOKEN, or configure an HTTPS or loopback server in your user profile.'); }
}

export async function callOperation(operation: Operation, fields: Record<string, unknown>, confirmed: boolean) {
  const { path, body } = operationRequest(operation, fields);
  const { origin, token } = await connection();
  function failure(type: 'protocol' | 'transport' | 'server', code: string): never {
    if (body) throw new CliError(type, code, 'Outcome unknown. Use command receipt get with the original token, Epoch and idempotency key before taking further action.',
      { operation: 'command.receipt.get', input: { epoch: String(body.epoch), idempotencyKey: String(body.idempotencyKey) } });
    throw new CliError(type, code, 'The server did not return a valid operation result.');
  }
  const headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' });
  if (body) headers.set('content-type', 'application/json');
  if (confirmed && operation.risk === 'high-risk-write') headers.set('X-ClinMesh-Confirm', operation.id);
  let response: Response;
  try { response = await fetch(origin + path, { method: operation.http.method, headers, body: body && JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
  catch { return failure('transport', 'NETWORK_FAILURE'); }
  if (response.status >= 500 || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); return failure('server', `HTTP_${response.status}`); }
  if (!response.ok) {
    const error = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/) }).safeParse(await response.json().catch(() => null));
    const code = error.data?.code ?? `HTTP_${response.status}`;
    throw new CliError([401, 403].includes(response.status) ? 'authorization' : 'server', code, `The server rejected ${operation.id} (HTTP ${response.status}).`);
  }
  try { return operation.outputSchema.parse(await response.json()); }
  catch { return failure('protocol', 'INVALID_RESPONSE'); }
}
