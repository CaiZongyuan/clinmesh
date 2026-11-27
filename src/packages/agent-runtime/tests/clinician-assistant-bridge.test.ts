import { afterEach, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { assistantServerFrame, assistantView } from '../../agent-protocol';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { openAiText, userProvider, withProvider } from '../../../../scripts/testing/agent-provider';
import { createNodeSqliteStore } from '../../store';
import { openPatient, patientHost, type PatientHttp } from './patient-fixture';

const stores: ReturnType<typeof createNodeSqliteStore>[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

it('binds the assistant session list to the responsible clinician, encounter and active epoch', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  stores.push(store);
  const http = patientHost(store);
  const clinic = await openPatient(http);
  const binding = { workspaceId: clinic.workspace.workspaceId, epoch: clinic.workspace.epoch, encounterId: clinic.encounterId, roleId: 'family-clinician' };
  const list = (roleId: string) => http('/api/assistant/sessions', { method: 'POST', headers: clinic.headers, body: JSON.stringify({ ...binding, roleId, action: 'list' }) });
  expect((await list('coordinator')).status).toBe(403);
  const result = await list(binding.roleId);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ threads: [{ title: expect.any(String) }], messages: [] });
});

type Connect = (path: string, cookie: string, receive: (data: string, reply: (text: string) => void) => void) => Promise<() => void>;
async function exerciseBridge(http: PatientHttp, connect: Connect) {
  const clinic = await openPatient(http);
  const binding = { workspaceId: clinic.workspace.workspaceId, epoch: clinic.workspace.epoch, encounterId: clinic.encounterId, roleId: 'family-clinician' };
  const post = (path: string, input: object, extra = {}) => http(`/api/assistant/${path}`, { method: 'POST', headers: { ...clinic.headers, ...extra }, body: JSON.stringify({ ...binding, ...input }) });
  const first = assistantView.parse(await (await post('sessions', { action: 'list' })).json());
  const channel = { thread: first.thread, clientId: crypto.randomUUID() };
  let ready!: () => void;
  const connected = new Promise<void>(resolve => { ready = resolve; });
  const calls: string[] = [];
  const query = new URLSearchParams({ ...binding, clientId: channel.clientId, thread: String(channel.thread) });
  const done = await connect(`/api/assistant/bridge?${query}`, clinic.headers.cookie, (data, reply) => {
    const frame = assistantServerFrame.parse(JSON.parse(data));
    if (frame.type === 'ready') ready();
    if (frame.type !== 'call') return;
    calls.push(frame.request.tool);
    if (frame.request.tool === 'ui_act') expect(frame.request.args.steps.at(-1)).toMatchObject({ action: 'setValue', args: ['I have had a fever and a cough for three days.'] });
    reply(JSON.stringify({ type: 'result', id: frame.id, result: frame.request.tool === 'ui_act' ? { ok: true } : [] }));
  });
  try {
    await connected;
    const request = { ...channel, content: 'Draft the concern from the clinical encounter.', requestId: crypto.randomUUID() };
    const response = await post('turn', request, { 'X-ClinMesh-LLM-Mock': '1' });
    const result = assistantView.parse(await response.json());
    expect(calls).toEqual(['ui_snapshot', 'ui_act']);
    expect(result.messages.map(message => message.role)).toContain('assistant');
    expect((await clinic.read()).turns).toHaveLength(1);
    expect(await (await post('turn', request, { 'X-ClinMesh-LLM-Mock': '1' })).json()).toEqual(result);
    expect(await (await post('turn', { ...channel, requestId: request.requestId }, { 'X-ClinMesh-LLM-Mock': '1' })).json()).toEqual(result);
    expect((await post('turn', { ...request, content: 'Different instruction' }, { 'X-ClinMesh-LLM-Mock': '1' })).status).toBe(409);
    expect(calls).toHaveLength(2);
    const branch = assistantView.parse(await (await post('sessions', { thread: first.thread, action: 'fork', title: 'Review' })).json());
    expect(branch.messages).toEqual(result.messages);
    expect(branch.thread).not.toBe(first.thread);
    expect(assistantView.parse(await (await post('sessions', { action: 'delete', thread: branch.thread })).json()).threads).toEqual(first.threads);
    expect((await post('sessions', { action: 'list', thread: branch.thread })).status).toBe(404);
    await clinic.command('/api/workspace/role', 2, { roleId: 'intake' });
    expect((await post('turn', request, { 'X-ClinMesh-LLM-Mock': '1' })).status).toBe(403);
  } finally { done(); }
}

it('runs native durable tools and scoped UI calls over the production Node WebSocket', async () => {
  await withNodeWorkspace(async origin => exerciseBridge((path, init) => fetch(origin + path, init), async (path, cookie, receive) => {
    const socket = new NodeWebSocket(origin.replace('http:', 'ws:') + path, { origin, headers: { cookie } });
    await new Promise<void>((resolve, reject) => { socket.on('message', data => receive(String(data), text => socket.send(text))); socket.once('open', resolve); socket.once('error', reject); });
    return () => socket.close();
  }), false, { CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_PORT: '51992' });
}, 30000);

it('runs the same bridge and CAP closure through the production workerd Workspace Durable Object', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: { CLINMESH_VISITOR_PASSCODE: 'test-passcode' } } }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const origin = 'https://clinical.example';
    const http: PatientHttp = (path, init) => worker.fetch(origin + path, init);
    await exerciseBridge(http, async (path, cookie, receive) => {
      const response = await worker.fetch(origin + path, { headers: { upgrade: 'websocket', cookie, origin } });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.addEventListener('message', event => receive(String(event.data), text => socket.send(text)));
      socket.accept();
      return () => socket.close(1000);
    });
    const clinic = await openPatient(http);
    const response = await http('/api/eval/runs', { method: 'POST', headers: { ...clinic.headers, 'X-ClinMesh-LLM-Mock': '1' }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 12, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
    expect(z.object({ status: z.string() }).parse(await response.json()).status).toBe('completed');
  } finally { await server.close(); }
}, 45000);

it('offers stable read-only tools to a real provider transport and returns only the bound clinical view', async () => {
  const requests: { names: string[]; message: string }[] = [];
  await withProvider(51993, (_, response, payload) => {
    const body = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })), messages: z.array(z.json()) }).parse(JSON.parse(payload));
    requests.push({ names: body.tools.map(tool => tool.function.name), message: JSON.stringify(body.messages) });
    if (requests.length > 1) { openAiText(response, 'The patient has a recorded penicillin allergy.'); return; }
    const common = { id: 'scripted-599', model: 'synthetic-model', object: 'chat.completion.chunk', created: 1800000000 };
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'read599', type: 'function', function: { name: 'read_encounter', arguments: '{}' } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  }, async baseUrl => withNodeWorkspace(async origin => {
    const clinic = await openPatient((path, init) => fetch(origin + path, init));
    const binding = { workspaceId: clinic.workspace.workspaceId, epoch: clinic.workspace.epoch, encounterId: clinic.encounterId, roleId: 'family-clinician' };
    const post = (path: string, body: object) => fetch(`${origin}/api/assistant/${path}`, { method: 'POST', headers: { ...clinic.headers, ...userProvider(baseUrl) }, body: JSON.stringify({ ...binding, ...body }) });
    const { thread } = assistantView.parse(await (await post('sessions', { action: 'list' })).json());
    const clientId = crypto.randomUUID();
    const query = new URLSearchParams({ ...binding, thread: String(thread), clientId });
    const socket = new NodeWebSocket(`${origin.replace('http:', 'ws:')}/api/assistant/bridge?${query}`, { origin, headers: { cookie: clinic.headers.cookie } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject); });
      const state = assistantView.parse(await (await post('turn', { thread, clientId, requestId: crypto.randomUUID(), content: 'Read my patient’s prior history.' })).json());
      expect(state.messages.at(-1)?.text).toBe('The patient has a recorded penicillin allergy.');
      expect(requests).toHaveLength(2);
      expect(requests[0]?.names).toEqual(requests[1]?.names);
      expect(requests[0]?.names).toEqual(expect.arrayContaining(['read_encounter', 'catalog_diagnoses', 'lab_read', 'prescription_read', 'ui_act']));
      expect(requests[0]?.names.join(' ')).not.toMatch(/truth|debrief|sign|question|eval|complete|workspace/);
      expect(requests[1]?.message).toContain('penicillin');
      expect(JSON.stringify(requests)).not.toMatch(/Focal right lower lobe consolidation|hiddenHistory|synthetic-user-only-key/);
    } finally { socket.close(); }
  }, false, { CLINMESH_PORT: '51994', CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl }));
}, 30000);
