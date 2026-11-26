import { expect, it } from 'vitest';
import { createNodeSqliteStore } from '../../store';
import { openPatient, patientHost } from './patient-fixture';
import { userProvider, withProvider } from '../../../../scripts/testing/agent-provider';

it('uses Anthropic Messages and Gemini generateContent with separate role models and real SDK transports', async () => {
  const requests: { path?: string; key?: string | string[]; payload: string }[] = [];
  await withProvider(51925, (request, response, payload) => {
    requests.push({ path: request.url, key: request.headers['x-api-key'] ?? request.headers['x-goog-api-key'], payload });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url?.includes(':streamGenerateContent')) {
      response.end(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } })}\n\n`);
    } else {
      const events = [
        { type: 'message_start', message: { id: 'teaching-message', role: 'assistant', type: 'message', content: [], model: 'synthetic-patient', usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
      ];
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    }
  }, async baseUrl => {
    const store = createNodeSqliteStore({ dbPath: ':memory:' });
    try {
      const http = patientHost(store, { CLINMESH_LLM_PROVIDER: 'anthropic', CLINMESH_LLM_BASE_URL: baseUrl, CLINMESH_LLM_API_KEY: 'synthetic-host-only', CLINMESH_LLM_PATIENT_MODEL: 'synthetic-patient', CLINMESH_LLM_CLINICIAN_MODEL: 'synthetic-clinician' });
      const { headers } = await openPatient(http);
      const probe = async (provider: Record<string, string>, role: string) => (await http('/api/agents/providers/test', { method: 'POST', headers: { ...headers, ...provider }, body: JSON.stringify({ role }) })).json();
      expect(await probe({}, 'patient')).toEqual({ ok: true, provider: 'anthropic', model: 'synthetic-patient' });
      expect(await probe({}, 'clinician')).toEqual({ ok: true, provider: 'anthropic', model: 'synthetic-clinician' });
      expect(await probe(userProvider(baseUrl, 'gemini'), 'patient')).toEqual({ ok: true, provider: 'gemini', model: 'synthetic-model' });
      expect(await probe({ 'X-ClinMesh-LLM-Api-Key': 'synthetic-browser-only' }, 'clinician')).toEqual({ ok: true, provider: 'anthropic', model: 'synthetic-clinician' });
      expect(requests[3]?.key).toBe('synthetic-browser-only');
      expect(requests[0]?.path).toMatch(/\/messages/); expect(requests[0]?.key).toBe('synthetic-host-only');
      expect(requests[0]?.payload).toContain('synthetic-patient'); expect(requests[1]?.payload).toContain('synthetic-clinician');
      expect(requests[2]?.path).toContain('synthetic-model:streamGenerateContent'); expect(requests[2]?.key).toBe('synthetic-user-only-key');
    } finally { await store.close(); }
  });
});

it.each([429, 504])('returns a sanitized actionable probe failure for upstream %i without Mock Mode', async status => {
  await withProvider(51926, (_, response) => { response.writeHead(status); response.end('synthetic-user-only-key'); }, async baseUrl => {
    const store = createNodeSqliteStore({ dbPath: ':memory:' });
    try {
      const http = patientHost(store, { CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl });
      const clinic = await openPatient(http);
      const response = await http('/api/agents/providers/test', { method: 'POST', headers: { ...clinic.headers, ...userProvider(baseUrl) }, body: '{}' });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code: status === 429 ? 'LLM_PROVIDER_RATE_LIMITED' : 'LLM_PROVIDER_TIMEOUT', settings: '#model-settings' });
      expect(JSON.stringify(await store.exportLogicalSnapshot(clinic.workspace.workspaceId))).not.toContain('synthetic-user-only-key');
    } finally { await store.close(); }
  });
});
