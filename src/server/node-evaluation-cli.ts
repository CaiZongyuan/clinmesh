import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EvaluationGateway, OperationInput } from '../packages/agent-runtime';
import { CoreError } from '../packages/platform';
import { handleError } from './workspace';

export async function openCliEnvironment(gateway: EvaluationGateway) {
  const app = new Hono();
  const token = randomBytes(32).toString('hex');
  app.onError(handleError);
  for (const entry of gateway.operations) app.on(entry.http.method, entry.http.path, async context => {
    if (context.req.header('Authorization') !== `Bearer ${token}`) throw new CoreError(403, 'ROLE_FORBIDDEN');
    if (entry.risk === 'high-risk-write' && context.req.header('X-ClinMesh-Confirm') !== entry.id) throw new CoreError(403, 'CONFIRMATION_REQUIRED');
    const body = entry.requiresIdempotencyKey ? z.record(z.string(), z.json()).parse(await context.req.json()) : {};
    return Response.json(await gateway.invoke(entry.id, { ...body, ...context.req.param(), ...context.req.query() }));
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new CoreError(503, 'CLI_LISTENER_UNAVAILABLE');
  const origin = `http://127.0.0.1:${address.port}`;
  return { async invoke(name: string, input: OperationInput) {
    const entry = gateway.operations.find(operation => operation.id === name);
    if (!entry) throw new CoreError(403, 'ROLE_FORBIDDEN');
    const child = spawn(process.execPath, [resolve('bin/clinmesh.mjs'), ...entry.cliPath.split(' '), '--input', '-', '--json', ...(entry.risk === 'high-risk-write' ? ['--yes'] : [])], {
      windowsHide: true, timeout: 35000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, CLINMESH_SERVER_URL: origin, CLINMESH_TOKEN: token }, stdio: 'pipe',
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.stdin.on('error', () => {});
    const ended = once(child, 'close');
    child.stdin.end(JSON.stringify(input));
    const [code] = await ended;
    if (code !== 0) {
      let reason = 'CLI_EXECUTION_FAILED';
      try { reason = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]+$/) }).parse(JSON.parse(stderr)).code; } catch {}
      throw new CoreError(409, reason);
    }
    return z.object({ ok: z.literal(true), operation: z.literal(name), data: z.json() }).parse(JSON.parse(stdout)).data;
  }, close: () => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())) };
}
