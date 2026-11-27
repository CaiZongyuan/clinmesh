import { afterEach, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { assistantObservations, assistantServerFrame, assistantView, observationKey, receiptSchema, uiCommandKey, type AssistantChannel } from '../../agent-protocol';
import { workspaceSchema } from '../../clinical-core';
import { studyViewSchema } from '../../diagnostic-studies';
import { parseHospitalDataPack } from '../../data-pack';
import diagnosticPack from '../../../../data/packs/diagnostic-teaching/pack.json';
import { studyWorkspace } from '../../../../scripts/testing/study-workspace';
import { withNodeDatabase, withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { openAiText, userProvider, withProvider } from '../../../../scripts/testing/agent-provider';
import { createNodeSqliteStore } from '../../store';
import { openPatient, patientHost, type PatientHttp } from './patient-fixture';

const stores: ReturnType<typeof createNodeSqliteStore>[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

it('collects successive finalized consultations and every signed imaging and pathology version between polls', async () => {
  const host = await studyWorkspace(parseHospitalDataPack(diagnosticPack));
  try {
    const binding = { ...host.at, roleId: 'clinician', encounterId: host.encounterId };
    const observe = async () => assistantObservations.parse(await (await host.request('/api/assistant/observations', { method: 'POST', body: JSON.stringify(binding) })).json());
    expect(await observe()).toEqual([]);
    for (const question of ['How do you feel?', 'When was your procedure?']) {
      const reply = receiptSchema.parse(await host.write(`${host.base}/consultation/turns`, (await host.encounter()).version, { content: question, channel: 'text' }, undefined, 'POST', { 'X-ClinMesh-LLM-Mock': '1' }));
      await (await host.request(`/api/agents/sessions/${reply.sessionId}/events?questionId=${reply.turnId}`, { headers: { 'X-ClinMesh-LLM-Mock': '1' } })).text();
    }
    const imaging = host.study('imaging'); const pathology = host.study('pathology');
    const first = await imaging.report(await imaging.issue('Noncontrast chest CT'));
    const tissue = await pathology.report(await pathology.issue('Surgical pathology consultation', 'excision-01'));
    await host.role('coordinator'); await imaging.review(first.id, 'amend', 4, 1); await host.role('clinician');
    const events = await observe();
    expect(events).toHaveLength(5);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'consultation.final', ordinal: 3, question: 'How do you feel?' }), expect.objectContaining({ type: 'consultation.final', ordinal: 5, question: 'When was your procedure?' }),
      expect.objectContaining({ kind: 'imaging', version: 1, id: first.id }), expect.objectContaining({ kind: 'imaging', version: 2 }), expect.objectContaining({ kind: 'pathology', version: 1, id: tissue.id }),
    ]));
    expect((await observe()).map(observationKey)).toEqual(events.map(observationKey));
  } finally { await host.close(); }
});

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

it('recovers the original empty-output failure after Node restarts and runs an explicit fresh attempt once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-assistant-recovery-'));
  let generations = 0;
  try {
    await withProvider(51995, (_, response) => openAiText(response, ++generations === 1 ? '' : 'Second attempt succeeded.'), async baseUrl => {
      const env = { CLINMESH_PORT: '51996', CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl };
      let cookie = '';
      let binding: { workspaceId: string; epoch: string; encounterId: string; roleId: string; thread: number; clientId: string };
      const requestId = crypto.randomUUID();
      for (const launch of [1, 2]) await withNodeDatabase(join(directory, 'workbench.sqlite'), async origin => {
        const post = (path: string, body: object) => fetch(`${origin}/api/assistant/${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...userProvider(baseUrl) }, body: JSON.stringify(body) });
        if (launch === 1) {
          const clinic = await openPatient((path, init) => fetch(origin + path, init)); cookie = clinic.headers.cookie;
          const scope = { workspaceId: clinic.workspace.workspaceId, epoch: clinic.workspace.epoch, encounterId: clinic.encounterId, roleId: 'family-clinician' };
          const { thread } = assistantView.parse(await (await post('sessions', { ...scope, action: 'list' })).json());
          binding = { ...scope, thread, clientId: crypto.randomUUID() };
        }
        const channel = binding!;
        const query = new URLSearchParams({ ...channel, thread: String(channel.thread) });
        const socket = new NodeWebSocket(`${origin.replace('http:', 'ws:')}/api/assistant/bridge?${query}`, { origin, headers: { cookie } });
        try {
          await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject); });
          const failure = await post('turn', { ...channel, requestId, ...(launch === 1 && { content: 'Review the encounter.' }) });
          expect(await failure.json()).toMatchObject({ code: 'LLM_PROVIDER_EMPTY_REPLY' });
          expect(generations).toBe(1);
          if (launch === 2) {
            const result = await post('turn', { ...channel, requestId: crypto.randomUUID(), retryOf: requestId });
            expect(assistantView.parse(await result.json()).messages.at(-1)?.text).toBe('Second attempt succeeded.');
            expect(generations).toBe(2);
          }
        } finally { socket.close(); }
      }, false, env);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

it.each(['generation', 'unanswered UI', 'approved clinical command', 'stop before restart', 'stop after restart'] as const)('rejoins an interrupted %s across actual Node process termination', async scenario => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-assistant-cutoff-'));
  const db = join(directory, 'clinic.sqlite');
  const requestId = crypto.randomUUID();
  const interruptedUi = scenario === 'unanswered UI' || scenario === 'approved clinical command';
  const cancelled = scenario === 'stop before restart' || scenario === 'stop after restart';
  let upstream = 0; let browserCalls = 0; let signalArrival!: () => void;
  const arrived = new Promise<void>(resolve => { signalArrival = resolve; });
  let cookie = ''; let channel!: AssistantChannel;
  try {
    await withProvider(51995, (_, response) => {
      upstream++;
      if (upstream === 1 && !interruptedUi) { signalArrival(); return; }
      if (upstream === 1) {
        const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'confirm-in-ui', type: 'function', function: { name: 'ui_act', arguments: JSON.stringify({ steps: [{ ref: 'Sign record', action: 'press' }] }) } }] };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'ui', model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'ui', model: 'synthetic-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      } else openAiText(response, 'Recovered the current instruction.');
    }, async baseUrl => {
      const env = { CLINMESH_PORT: '51996', CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl };
      for (const launch of [1, 2]) await withNodeDatabase(db, async origin => {
        const post = (path: string, body: object) => fetch(`${origin}/api/assistant/${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...userProvider(baseUrl) }, body: JSON.stringify(body) });
        let sign: ((token: string) => Promise<void>) | undefined;
        if (launch === 1) {
          const clinic = await openPatient((path, init) => fetch(origin + path, init)); cookie = clinic.headers.cookie;
          const binding = { workspaceId: clinic.workspace.workspaceId, epoch: clinic.workspace.epoch, encounterId: clinic.encounterId, roleId: 'family-clinician' };
          const { thread } = assistantView.parse(await (await post('sessions', { ...binding, action: 'list' })).json()); channel = { ...binding, thread, clientId: crypto.randomUUID() };
          if (scenario === 'approved clinical command') {
            const visit = await clinic.read();
            const draft = await fetch(origin + `${clinic.base}/clinical-record/draft`, { method: 'PUT', headers: clinic.headers, body: JSON.stringify({ epoch: binding.epoch, expectedVersion: visit.version, idempotencyKey: crypto.randomUUID(), fields: Object.fromEntries(visit.template.filter(item => item.required).map(item => [item.id, `Reviewed ${item.id}`])), expectedDraftVersion: 0 }) });
            const saved = z.object({ version: z.int(), draftVersion: z.int() }).parse(await draft.json());
            sign = async token => {
              const formal = await fetch(origin + `${clinic.base}/clinical-record/sign`, { method: 'POST', headers: clinic.headers, body: JSON.stringify({ epoch: binding.epoch, expectedVersion: saved.version, idempotencyKey: uiCommandKey(token, 0), expectedDraftVersion: saved.draftVersion }) });
              expect(formal.status).toBe(200);
            };
          }
        }
        const socket = new NodeWebSocket(`${origin.replace('http:', 'ws:')}/api/assistant/bridge?${new URLSearchParams({ ...channel, thread: String(channel.thread) })}`, { origin, headers: { cookie } });
        await new Promise<void>((resolve, reject) => { socket.on('message', async data => {
          const frame = assistantServerFrame.parse(JSON.parse(String(data)));
          if (frame.type === 'ready') resolve();
          if (frame.type === 'call') { browserCalls++; if (sign) await sign(frame.commandToken!); signalArrival(); }
        }); socket.once('error', reject); });
        if (launch === 2 && scenario === 'stop after restart') {
          expect((await post('stop', { ...channel, clientId: crypto.randomUUID(), requestId })).status).toBe(403);
          expect((await post('stop', { ...channel, requestId })).status).toBe(200);
        }
        const task = post('turn', { ...channel, requestId, ...(launch === 1 && { content: 'Review the current instruction.' }) });
        if (launch === 1) {
          void task.catch(() => {}); await arrived;
          if (scenario === 'stop before restart') {
            expect((await post('stop', { ...channel, requestId: crypto.randomUUID() })).status).toBe(409);
            expect((await post('stop', { ...channel, requestId })).status).toBe(200);
          }
          return;
        }
        try {
          const response = await task;
          if (cancelled) {
            expect(await response.json()).toMatchObject({ code: 'ASSISTANT_STOPPED' }); expect(upstream).toBe(1);
            expect((await post('stop', { ...channel, requestId })).status).toBe(200);
            const next = await post('turn', { ...channel, requestId: crypto.randomUUID(), content: 'A new clinician instruction.' });
            expect(assistantView.parse(await next.json()).messages.at(-1)?.text).toBe('Recovered the current instruction.');
            expect(upstream).toBe(2); return;
          }
          const output = assistantView.parse(await response.json());
          expect(output.messages.at(-1)?.text).toBe('Recovered the current instruction.');
          expect(output.messages.filter(item => item.role === 'clinician')).toHaveLength(1);
          expect(browserCalls).toBe(interruptedUi ? 1 : 0);
          if (interruptedUi) expect(output.review?.committed).toEqual(scenario === 'approved clinical command' ? [expect.objectContaining({ operation: 'record.sign', result: expect.objectContaining({ revision: 1 }) })] : []);
          expect(await (await post('turn', { ...channel, requestId })).json()).toEqual(output);
          expect(upstream).toBe(2);
        } finally { socket.close(); }
      }, false, env);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
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
    const result = await response.json();
    const { status, runId } = z.object({ status: z.string(), runId: z.uuidv7() }).parse(result);
    expect(status).toBe('completed');
    const runStorage = await worker.getDurableObjectStorage('WORKSPACE_DO', { name: runId });
    const ownerStorage = await worker.getDurableObjectStorage('WORKSPACE_DO', { name: clinic.workspace.workspaceId });
    expect(await runStorage.exec('SELECT id FROM workspaces')).toEqual([{ id: runId }]);
    expect(await ownerStorage.exec('SELECT id FROM workspaces')).toEqual([{ id: clinic.workspace.workspaceId }]);
    await worker.evictDurableObject('WORKSPACE_DO', { name: runId });
    await worker.evictDurableObject('WORKSPACE_DO', { name: clinic.workspace.workspaceId });
    expect(await (await http(`/api/eval/runs/${runId}`, { headers: clinic.headers })).json()).toEqual(result);
  } finally { await server.close(); }
}, 45000);

it.each([false, true])('offers stable read-only tools to a real provider transport with diagnostic studies enabled: %s', async studies => {
  const requests: { names: string[]; message: string }[] = [];
  const answer = studies ? 'The signed study is available.' : 'The patient has a recorded penicillin allergy.';
  await withProvider(51993, (_, response, payload) => {
    const body = z.object({ tools: z.array(z.object({ function: z.object({ name: z.string() }) })), messages: z.array(z.json()) }).parse(JSON.parse(payload));
    requests.push({ names: body.tools.map(tool => tool.function.name), message: JSON.stringify(body.messages) });
    if (requests.length > 1) { openAiText(response, answer); return; }
    const common = { id: 'scripted-599', model: 'synthetic-model', object: 'chat.completion.chunk', created: 1800000000 };
    const names = studies ? ['imaging_read', 'pathology_read'] : ['read_encounter'];
    const delta = { role: 'assistant', tool_calls: names.map((name, index) => ({ index, id: `read599-${index}`, type: 'function', function: { name, arguments: '{}' } })) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  }, async baseUrl => withNodeWorkspace(async origin => {
    const clinic = await openPatient((path, init) => fetch(origin + path, init));
    let binding = { workspaceId: clinic.workspace.workspaceId, epoch: clinic.workspace.epoch, encounterId: clinic.encounterId, roleId: 'family-clinician' };
    if (studies) {
      const write = async (path: string, epoch: string, expectedVersion: number, fields = {}) => {
        const response = await fetch(origin + path, { method: 'POST', headers: clinic.headers, body: JSON.stringify({ epoch, expectedVersion, idempotencyKey: crypto.randomUUID(), ...fields }) });
        expect(response.status).toBe(200);
        return z.record(z.string(), z.json()).parse(await response.json());
      };
      await write('/api/workspace/role', binding.epoch, 2, { roleId: 'coordinator' });
      await write('/api/workspace/reset', binding.epoch, 0, { packId: 'diagnostic-teaching' });
      const workspace = workspaceSchema.parse(await (await fetch(`${origin}/api/workspace`, { headers: clinic.headers })).json());
      await write('/api/workspace/role', workspace.epoch, workspace.sessionVersion, { roleId: 'clinician' });
      const encounterId = z.uuidv7().parse((await write(`/api/his/cases/${workspace.cases[0]!.id}/start-encounter`, workspace.epoch, 0)).encounterId);
      binding = { workspaceId: workspace.workspaceId, epoch: workspace.epoch, encounterId, roleId: 'clinician' };
      const imaging = `/api/his/encounters/${encounterId}/imaging`;
      const view = studyViewSchema.parse(await (await fetch(origin + imaging, { headers: clinic.headers })).json());
      const item = view.services.find(service => service.display.en === 'Noncontrast chest CT')!.quote;
      const order = await write(`${imaging}/issue`, workspace.epoch, 1, { item });
      for (const [index, step] of ['accept', 'start', 'report-now'].entries()) await write(`/api/his/imaging/orders/${order.orderId}/${step}`, workspace.epoch, index + 1);
    }
    const post = (path: string, body: object) => fetch(`${origin}/api/assistant/${path}`, { method: 'POST', headers: { ...clinic.headers, ...userProvider(baseUrl) }, body: JSON.stringify({ ...binding, ...body }) });
    const { thread } = assistantView.parse(await (await post('sessions', { action: 'list' })).json());
    const clientId = crypto.randomUUID();
    const query = new URLSearchParams({ ...binding, thread: String(thread), clientId });
    const socket = new NodeWebSocket(`${origin.replace('http:', 'ws:')}/api/assistant/bridge?${query}`, { origin, headers: { cookie: clinic.headers.cookie } });
    try {
      await new Promise<void>((resolve, reject) => { socket.once('message', () => resolve()); socket.once('error', reject); });
      const state = assistantView.parse(await (await post('turn', { thread, clientId, requestId: crypto.randomUUID(), content: 'Read my patient’s prior history.' })).json());
      expect(state.messages.at(-1)?.text).toBe(answer);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.names).toEqual(requests[1]?.names);
      expect(requests[0]?.names).toEqual(expect.arrayContaining(['read_encounter', 'catalog_diagnoses', 'ui_act']));
      expect(requests[0]?.names.join(' ')).not.toMatch(/truth|debrief|sign|question|eval|complete|workspace|frames|acknowledge|report_now/);
      expect(requests[0]?.names).toEqual(expect.arrayContaining(studies ? ['imaging_read', 'pathology_read'] : ['lab_read', 'prescription_read']));
      expect(requests[0]?.names).not.toEqual(expect.arrayContaining(studies ? ['lab_read', 'prescription_read'] : ['imaging_read', 'pathology_read']));
      expect(requests[1]?.message).toContain(studies ? 'Postoperative scar without a focal mass.' : 'penicillin');
      expect(JSON.stringify(requests)).not.toMatch(/Focal right lower lobe consolidation|hiddenHistory|synthetic-user-only-key/);
    } finally { socket.close(); }
  }, false, { CLINMESH_PORT: '51994', CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl }));
}, 30000);
