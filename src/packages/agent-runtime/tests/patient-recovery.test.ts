import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { withNodeDatabase } from '../../../../scripts/testing/node-workspace';
import { receiptSchema } from '../../agent-protocol';
import { encounterViewSchema } from '../../clinical-core';
import { openPatient } from './patient-fixture';
import { openAiText, userProvider, withProvider } from './provider-fixture';

it('rejoins a killed Node process at its Pi checkpoint with request-time BYOK, and resumes the SSE cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-patient-recovery-'));
  const database = join(directory, 'recovery.sqlite');
  let receive!: () => void;
  const arrived = new Promise<void>(resolve => { receive = resolve; });
  let calls = 0;
  try {
    await withProvider(51924, (_, response) => {
      calls++;
      if (calls === 1) { receive(); return; }
      openAiText(response, 'It started after I got home.');
    }, async baseUrl => {
      const environment = { CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl, CLINMESH_PORT: '51921' };
      const settings = userProvider(baseUrl);
      let events = '', visit = '', cookie = '', cursor = '';
      await withNodeDatabase(database, async origin => {
        const clinic = await openPatient((path, init) => fetch(origin + path, init));
        const answer = receiptSchema.parse(await (await clinic.ask('When did it start?', 1, settings)).json());
        events = `/api/agents/sessions/${answer.sessionId}/events?questionId=${answer.turnId}`;
        visit = clinic.base; cookie = clinic.headers.cookie;
        await arrived;
        const response = await clinic.ask('A second question', 1, settings);
        expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'CONSULTATION_REPLY_IN_FLIGHT' });
        const abort = new AbortController();
        const feed = await fetch(origin + events, { signal: abort.signal, headers: { cookie } });
        const reader = feed.body!.getReader();
        const frame = new TextDecoder().decode((await reader.read()).value);
        expect(frame).toContain('"status":"running"'); cursor = frame.match(/^id: (.+)$/m)![1]!;
        abort.abort();
      }, false, environment);
      await withNodeDatabase(database, async origin => {
        const missing = await fetch(origin + events, { headers: { cookie } });
        expect(await missing.json()).toMatchObject({ code: 'LLM_PROVIDER_UNCONFIGURED' });
        const rejoin = async () => (await fetch(origin + events, { headers: { ...settings, cookie, 'last-event-id': cursor } })).text();
        const [left, right] = await Promise.all([rejoin(), rejoin()]);
        expect(left).toBe(right); expect(left).toContain('It started after I got home.'); expect(left).not.toContain(`id: ${cursor}\n`);
        const completed = encounterViewSchema.parse(await (await fetch(origin + visit, { headers: { cookie } })).json());
        expect(completed.turns.map(turn => turn.speaker)).toEqual(['patient', 'clinician', 'patient']);
        const last = [...left.matchAll(/^id: (.+)$/gm)].at(-1)![1]!;
        expect(await (await fetch(origin + events, { headers: { cookie, 'last-event-id': last } })).text()).toBe('');
        expect(calls).toBe(2);
      }, false, environment);
      expect((await readFile(database)).includes(Buffer.from(settings['X-ClinMesh-LLM-Api-Key']))).toBe(false);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('replays approved Patient Agent output after production workerd evicts its SQLite Durable Object', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: { CLINMESH_VISITOR_PASSCODE: 'test-passcode' } } }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const http = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => worker.fetch(`https://clinic.example${path}`, init);
    const clinic = await openPatient(http);
    const mock = { 'X-ClinMesh-LLM-Mock': '1' };
    const receipt = receiptSchema.parse(await (await clinic.ask('Where does it hurt?', 1, mock)).json());
    const path = `/api/agents/sessions/${receipt.sessionId}/events?questionId=${receipt.turnId}`;
    const before = await (await http(path, { headers: { ...clinic.headers, ...mock } })).text();
    expect(before).toContain('"status":"done"');
    await worker.evictDurableObject('WORKSPACE_DO', { name: clinic.workspace.workspaceId });
    const after = await (await http(path, { headers: clinic.headers })).text();
    expect(after).toContain('Breathing deeply hurts my right side.');
    expect((await clinic.read()).turns).toHaveLength(3);
  } finally { await server.close(); }
}, 45_000);
