import { expect, it } from 'vitest';
import { z } from 'zod';
import { v7 } from 'uuid';
import { WebSocket as NodeWebSocket } from 'ws';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { userProvider, withProvider } from '../../../../scripts/testing/agent-provider';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { assistantView } from '../../agent-protocol';
import { openPatient, type PatientHttp } from './patient-fixture';
import { modelEvents, modelReplySchema } from './cds-model-transport';
import { sha256 } from '../../platform';

const tools = { cds_scores: 'scores', cds_guidelines: 'guidelines', cds_order_sets: 'order-sets' } as const;
type Connect = (path: string, cookie: string) => Promise<() => void>;
type Host = (url: string, run: (http: PatientHttp, connect: Connect) => Promise<void>) => Promise<void>;
const native: Host = (url, run) => withNodeWorkspace(async origin => run((path, init) => fetch(origin + path, init), async (path, cookie) => {
  const socket = new NodeWebSocket(origin.replace('http:', 'ws:') + path, { origin, headers: { cookie } });
  await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject); });
  return () => socket.close();
}), false, { CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: url });
const durable: Host = async (url, run) => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, main: 'src/packages/agent-runtime/tests/cds-model-worker.ts', assets: undefined, vars: { CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: url } } }] });
  try {
    await server.listen();
    const worker = server.getWorker(), origin = 'https://clinical.example';
    await run((path, init) => worker.fetch(origin + path, init), async (path, cookie) => {
      const response = await worker.fetch(origin + path, { headers: { origin, cookie, upgrade: 'websocket' } });
      expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept();
      return () => socket.close(1000);
    });
  } finally { await server.close(); }
};

it.each([['Node', 51983, native], ['workerd', 51984, durable]] as const)('binds all three live Clinician Assistant CDS tools to the active clinician and encounter on %s', async (_name, port, host) => {
  const exercise = (url: string) => host(url, async (http, connect) => {
    const clinic = await openPatient(http);
    const base = `/api/his/encounters/${clinic.encounterId}`;
    const command = (path: string, version: number, fields: object) => http(path, { method: 'POST', headers: clinic.headers, body: JSON.stringify({ expectedVersion: version, idempotencyKey: crypto.randomUUID(), epoch: clinic.workspace.epoch, ...fields }) });
    const otherCase = clinic.workspace.cases.find(item => item.demographics.name === 'Jordan Vale')!;
    const otherVisit = z.object({ encounterId: z.uuidv7() }).parse(await (await command(`/api/his/cases/${otherCase.id}/start-encounter`, 0, {})).json());
    expect((await command(`${base}/cds/risk-assessment`, 1, { expectedRevision: 0, fields: { weightKg: 72.4 } })).status).toBe(200);
    expect((await command(`/api/his/encounters/${otherVisit.encounterId}/cds/risk-assessment`, 1, { expectedRevision: 0, fields: { weightKg: 118.6 } })).status).toBe(200);
    const binding = { workspaceId: clinic.workspace.workspaceId, epoch: clinic.workspace.epoch, encounterId: clinic.encounterId, roleId: 'family-clinician' };
    const post = (action: string, fields: object) => http(`/api/assistant/${action}`, { method: 'POST', headers: { ...clinic.headers, ...userProvider(url) }, body: JSON.stringify({ ...binding, ...fields }) });
    expect((await post('sessions', { action: 'list', roleId: 'coordinator' })).status).toBe(403);
    expect((await post('sessions', { action: 'list', epoch: v7() })).status).toBe(409);
    const { thread } = assistantView.parse(await (await post('sessions', { action: 'list' })).json());
    const clientId = crypto.randomUUID();
    const close = await connect(`/api/assistant/bridge?${new URLSearchParams({ ...binding, thread: String(thread), clientId })}`, clinic.headers.cookie);
    try {
      const response = await post('turn', { thread, clientId, requestId: crypto.randomUUID(), content: 'Review the clinical scores, guidelines and screened order sets for this encounter.' });
      const result = await response.json(); expect([response.status, result]).toEqual([200, expect.anything()]);
      const answer = modelReplySchema.parse(JSON.parse(assistantView.parse(result).messages.at(-1)!.text));
      expect(answer.offered).toEqual(expect.arrayContaining(Object.keys(tools)));
      expect(answer.offered).not.toContain('cds_risk_assessment');
      for (const [name, path] of Object.entries(tools)) {
        const expected = await (await http(`${base}/cds/${path}`, { headers: clinic.headers })).json();
        expect(answer.evidence[name], name).toBe(await sha256(JSON.stringify(expected)));
      }
      expect(answer.foreignData).toBe(false);
    } finally { close(); }
  });
  if (host === durable) await exercise('https://cds-model.example/v1');
  else await withProvider(port, async (_, response, payload) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(await modelEvents(payload));
  }, exercise);
}, 45_000);
