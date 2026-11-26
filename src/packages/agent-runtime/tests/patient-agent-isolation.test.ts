import { expect, it } from 'vitest';
import { z } from 'zod';
import { resolveAgentProvider } from '../index';
import { createNodeSqliteStore } from '../../store';
import { openPatient, patientHost } from './patient-fixture';
import { openAiText, userProvider, withProvider } from './provider-fixture';
import { receiptSchema } from '../../agent-protocol';

it('stops an ongoing request, retries the same clinician turn and rejects stale stop commands', async () => {
  let arrive!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  await withProvider(51927, (_, response) => { arrive(); response.once('close', () => {}); }, async baseUrl => {
    const store = createNodeSqliteStore({ dbPath: ':memory:' });
    try {
      const http = patientHost(store, { CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl });
      const clinic = await openPatient(http);
      const receipt = receiptSchema.parse(await (await clinic.ask('What do you feel?', 1, userProvider(baseUrl))).json());
      await arrived;
      const input = { questionId: receipt.turnId, attempt: 1 };
      expect((await clinic.command(`${clinic.base}/consultation/stop`, 2, input)).status).toBe(200);
      const mock = { 'X-ClinMesh-LLM-Mock': '1' };
      const retried = receiptSchema.parse(await (await clinic.command(`${clinic.base}/consultation/retry`, 3, input, mock)).json());
      expect(retried).toMatchObject({ turnId: receipt.turnId, attempt: 2 });
      expect((await clinic.command(`${clinic.base}/consultation/stop`, 4, input)).status).toBe(409);
      const success = await http(`/api/agents/sessions/${receipt.sessionId}/events`, { headers: { ...clinic.headers, ...mock } });
      expect(await success.text()).toContain('Breathing deeply hurts my right side.');
      expect((await clinic.read()).turns.map(turn => turn.ordinal)).toEqual([1, 2, 3]);
    } finally { await store.close(); }
  });
});

it('requires explicit credentials or Mock Mode and never forwards a host key to a browser-selected endpoint', () => {
  expect(() => resolveAgentProvider(new Headers(), {})).toThrow('LLM_PROVIDER_UNCONFIGURED');
  const defaults = { CLINMESH_LLM_API_KEY: 'synthetic-host-only', CLINMESH_LLM_ALLOWED_BASE_URLS: 'https://custom.example/v1' };
  const changed = new Headers({ 'X-ClinMesh-LLM-Base-Url': 'https://custom.example/v1' });
  expect(() => resolveAgentProvider(changed, defaults)).toThrow('LLM_PROVIDER_UNCONFIGURED');
  expect(resolveAgentProvider(new Headers({ 'X-ClinMesh-LLM-Mock': '1' }), {}).provider).toBe('mock');
  expect(() => resolveAgentProvider(new Headers({ 'X-ClinMesh-LLM-Api-Key': 'synthetic-user-only', 'X-ClinMesh-LLM-Base-Url': 'https://unknown.example/' }), defaults)).toThrow('LLM_ENDPOINT_NOT_ALLOWED');
});

it('isolates the actual provider transcript and checks the entire answer before Pi, SSE and Consultation can see it', async () => {
  const requests: string[] = [];
  await withProvider(51922, (request, response, body) => {
    requests.push(body);
    expect(request.headers.authorization).toBe('Bearer synthetic-user-only-key');
    openAiText(response, requests.length === 1 ? 'I was told it is pneumonia. synthetic-rejected-answer' : 'It began yesterday.');
  }, async baseUrl => {
    const store = createNodeSqliteStore({ dbPath: ':memory:' });
    try {
      const http = patientHost(store, { CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl });
      const clinic = await openPatient(http);
      const settings = userProvider(baseUrl);
      const receipt = receiptSchema.parse(await (await clinic.ask('When did this start?', 1, settings)).json());
      const events = await (await http(`/api/agents/sessions/${receipt.sessionId}/events`, { headers: { ...clinic.headers, ...settings } })).text();
      expect(events).toContain('It began yesterday.');
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain('Worried but cooperative'); expect(requests[0]).toContain('When did this start?');
      expect(requests.join(' ')).not.toMatch(/J18\.9|pneumonia|Focal right lower lobe|hiddenHistory|synthetic-rejected-answer|caseTruth|clinician assistant/i);
      const snapshot = await store.exportLogicalSnapshot(clinic.workspace.workspaceId);
      expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-user-only-key|synthetic-rejected-answer/);
      expect(events).not.toMatch(/pneumonia|synthetic-user-only-key/);
      const calls = snapshot.tables.find(table => table.name === 'agent_model_calls')!.rows;
      expect(calls.map(item => [item.status, item.input_tokens, item.output_tokens])).toEqual([['rejected', 18, 7], ['ok', 18, 7]]);
    } finally { await store.close(); }
  });
});

it('replaces a second rejected answer and sanitizes a credential-echoing provider error before durable storage', async () => {
  let rejected = false;
  await withProvider(51923, (_, response) => {
    if (!rejected) { openAiText(response, 'The chart says J18.9 synthetic-blocked-code.'); return; }
    response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'upstream-secret-echo synthetic-user-only-key' } }));
  }, async baseUrl => {
    const store = createNodeSqliteStore({ dbPath: ':memory:' });
    try {
      const http = patientHost(store, { CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl });
      const clinic = await openPatient(http);
      const settings = userProvider(baseUrl);
      const headers = { ...clinic.headers, ...settings };
      const answer = async (question: string, version: number) => {
        const { sessionId, turnId } = receiptSchema.parse(await (await clinic.ask(question, version, settings)).json());
        return (await http(`/api/agents/sessions/${sessionId}/events?questionId=${turnId}`, { headers })).text();
      };
      expect(await answer('Do you know the cause?', 1)).toContain('I am not sure what is causing it.');
      rejected = true;
      expect(await answer('When did it change?', 3)).toContain('LLM_PROVIDER_AUTH_FAILED');
      const snapshot = await store.exportLogicalSnapshot(clinic.workspace.workspaceId);
      expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-blocked-code|synthetic-user-only-key|upstream-secret-echo/);
      expect((await clinic.read()).turns).toHaveLength(4);
      expect((await http('/api/agents/providers/test', { method: 'POST', headers, body: '{}' })).status).toBe(422);
    } finally { await store.close(); }
  });
});

it('admits one configured question, checkpoints its safe answer, and replays it without a second Consultation turn', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const http = patientHost(store);
    const clinic = await openPatient(http);
    expect(await (await clinic.ask('When did it begin?', 1)).json()).toMatchObject({ code: 'LLM_PROVIDER_UNCONFIGURED' });
    expect((await clinic.read()).turns).toHaveLength(1);
    const mock = { 'X-ClinMesh-LLM-Mock': '1' };
    const key = crypto.randomUUID();
    const response = await clinic.ask('Where does it hurt?', 1, mock, key);
    expect(response.status).toBe(200);
    const receipt = z.object({ sessionId: z.uuidv7(), turnId: z.uuidv7(), version: z.int(), attempt: z.int() }).parse(await response.json());
    const events = `/api/agents/sessions/${receipt.sessionId}/events?questionId=${receipt.turnId}`;
    const joined = await http(events, { headers: { ...clinic.headers, ...mock } });
    expect(joined.headers.get('content-type')).toContain('text/event-stream');
    expect(await joined.text()).toContain('Breathing deeply hurts my right side.');
    expect(await (await clinic.ask('Where does it hurt?', 1, mock, key)).json()).toEqual(receipt);
    expect((await clinic.read()).turns.map(turn => turn.speaker)).toEqual(['patient', 'clinician', 'patient']);
    const snapshot = await store.exportLogicalSnapshot(clinic.workspace.workspaceId);
    expect(snapshot.pi[0]?.tables.find(table => table.name === 'submissions')?.rows).toHaveLength(1);
  } finally { await store.close(); }
});
