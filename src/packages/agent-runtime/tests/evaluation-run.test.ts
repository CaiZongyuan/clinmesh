import { expect, it } from 'vitest';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteStore } from '../../store';
import { createApp } from '../../../server/app';
import { createWorkspaceApp } from '../../../server/workspace';
import { builtinModules } from '../../../server/builtin-modules';
import { openPatient } from './patient-fixture';
import { nodeEvaluations } from '../../../server/node-evaluations';
import { openAiText, userProvider, withProvider } from '../../../../scripts/testing/agent-provider';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';

it('finishes a CAP Evaluation Run with two durable agents, scored facts and a separate active clinician workspace', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const directory = await mkdtemp(join(tmpdir(), 'clinmesh-evaluation-'));
  const settings = { CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_SESSION_SECRET: 'synthetic-evaluation-workspace-signing-secret' };
  try {
    const workspace = createWorkspaceApp(store, settings, builtinModules, {}, undefined, undefined, nodeEvaluations(directory, {}));
    const app = createApp('node', settings, (request, credential, entering) => workspace.fetch(request, { credential, entering }), builtinModules);
    const http = async (path: string, init?: RequestInit) => app.request(`https://test.example${path}`, init);
    const clinic = await openPatient(http);
    const before = await clinic.read();
    const response = await http('/api/eval/runs', { method: 'POST', headers: { ...clinic.headers, 'X-ClinMesh-LLM-Mock': '1' }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 12, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
    const report = z.looseObject({ runId: z.uuidv7(), epoch: z.uuidv7(), turns: z.int(), error: z.string().nullable(), trace: z.array(z.looseObject({ operation: z.string(), role: z.string(), error: z.string().optional() })) }).parse(await response.json());
    expect(report, JSON.stringify({ turns: report.turns, error: report.error, operations: report.trace?.map((action: { operation: string; error?: string }) => [action.operation, action.error]) })).toMatchObject({ status: 'completed', hits: { diagnosis: true, investigations: { matched: 1 }, medications: { matched: 1 } }, redline: false });
    expect(response.status).toBe(201);
    expect(report.epoch).not.toBe(clinic.workspace.epoch);
    expect(report.trace.map((action: { operation: string }) => action.operation)).toEqual(expect.arrayContaining(['consultation.question', 'consultation.reply', 'lab.issue', 'lab.report-now', 'lab.acknowledge', 'diagnosis.confirm', 'prescription.sign', 'record.sign', 'encounter.complete']));
    expect(await clinic.read()).toEqual(before);
    expect(await store.read(reader => reader.getWorkspace(report.runId))).toBeUndefined();
    const reopened = createNodeSqliteStore({ dbPath: join(directory, `${report.runId}.sqlite`) });
    try { expect(await reopened.read(reader => reader.getWorkspace(report.runId))).toBeDefined(); } finally { await reopened.close(); }
    expect(await (await http(`/api/eval/runs/${report.runId}`, { headers: clinic.headers })).json()).toEqual(report);
    const outsider = await openPatient(http);
    expect((await http(`/api/eval/runs/${report.runId}`, { headers: outsider.headers })).status).toBe(404);
    const read = report.trace.findIndex(item => item.operation === 'read_report');
    const acknowledged = report.trace.findIndex(item => item.operation === 'acknowledge_report');
    expect(read).toBeGreaterThan(-1); expect(acknowledged).toBeGreaterThan(read);
    expect(report.trace[read]).toMatchObject({ role: 'family-clinician', output: { report: { observations: [{ value: 15.4 }] } } });
    expect((await http(`${clinic.base}/debrief`, { headers: clinic.headers })).status).toBe(403);
    const short = await http('/api/eval/runs', { method: 'POST', headers: { ...clinic.headers, 'X-ClinMesh-LLM-Mock': '1' }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 1, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
    expect(await short.json()).toMatchObject({ status: 'incomplete', hits: null, turns: 1 });
    const diagnostic = await http('/api/eval/runs', { method: 'POST', headers: { ...clinic.headers, 'X-ClinMesh-LLM-Mock': '1' }, body: JSON.stringify({ packId: 'diagnostic-teaching', caseId: 'teaching-01', maxTurns: 20, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
    const study = z.looseObject({ trace: z.array(z.object({ operation: z.string() })) }).parse(await diagnostic.json());
    expect(study).toMatchObject({ status: 'completed', hits: { diagnosis: true, investigations: { matched: 2, expected: 3 } } });
    expect(study.trace.map(item => item.operation)).toEqual(expect.arrayContaining(['imaging.issue', 'imaging.acknowledge', 'pathology.issue', 'pathology.acknowledge']));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

it('records real diagnosis and medication refusals with the responsible role and withholds scoring on incomplete runs', async () => {
  const calls = [
    { name: 'diagnose', args: { codeSystem: 'urn:synthetic:unknown', code: 'test' } },
    { name: 'diagnose', args: { codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9' } },
    { name: 'prescribe', args: { codeSystem: 'urn:clinmesh:general:drug', code: 'doxycycline', dose: 100, routeCode: 'IV', timesPerDay: 2, days: 5, quantity: 10 } },
  ];
  let index = 0;
  await withProvider(51997, (_, response) => {
    const next = calls[index++];
    if (!next) { openAiText(response, 'Assessment incomplete.'); return; }
    const common = { id: `eval-${index}`, model: 'tested-doctor', object: 'chat.completion.chunk', created: 1800000000 };
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: `action-${index}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  }, async baseUrl => withNodeWorkspace(async origin => {
    const clinic = await openPatient((path, init) => fetch(origin + path, init));
    const response = await fetch(`${origin}/api/eval/runs`, { method: 'POST', headers: { ...clinic.headers, ...userProvider(baseUrl) }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 5, clinicianModel: 'tested-doctor', patientModel: 'tested-patient' }) });
    expect(await response.json()).toMatchObject({ status: 'incomplete', redline: true, hits: null, trace: expect.arrayContaining([
      expect.objectContaining({ role: 'family-clinician', operation: 'diagnosis.draft', error: 'DIAGNOSIS_NOT_IN_CATALOG' }),
      expect.objectContaining({ role: 'family-clinician', operation: 'prescription.sign', error: 'PRESCRIPTION_ROUTE_NOT_ALLOWED' }),
    ]) });
  }, false, { CLINMESH_PORT: '51998', CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl }));
}, 30000);

it('records the terminal patient provider failure and counts answered consultations', async () => {
  let doctorCalls = 0;
  await withProvider(51997, (_, response, raw) => {
    const body = z.object({ model: z.string() }).parse(JSON.parse(raw));
    if (body.model === 'tested-patient') { response.writeHead(401); response.end('synthetic-private-failure-body'); return; }
    if (++doctorCalls > 1) { openAiText(response, 'The patient could not answer.'); return; }
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'ask-1', type: 'function', function: { name: 'ask_patient', arguments: JSON.stringify({ question: 'How do you feel?' }) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'doctor', model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'doctor', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  }, async baseUrl => withNodeWorkspace(async origin => {
    const clinic = await openPatient((path, init) => fetch(origin + path, init));
    const response = await fetch(`${origin}/api/eval/runs`, { method: 'POST', headers: { ...clinic.headers, ...userProvider(baseUrl) }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 4, clinicianModel: 'tested-doctor', patientModel: 'tested-patient' }) });
    const result = await response.json();
    expect(result).toMatchObject({ error: 'LLM_PROVIDER_AUTH_FAILED', patientTurns: 0, trace: expect.arrayContaining([expect.objectContaining({ role: 'patient', operation: 'consultation.reply', error: 'LLM_PROVIDER_AUTH_FAILED' })]) });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private-failure-body|synthetic-user-only-key/);
  }, false, { CLINMESH_PORT: '51998', CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl }));
}, 30000);

it('audits Pi argument rejection and requires a model round after a report returns before acknowledgement', async () => {
  let generation = 0;
  await withProvider(51997, (_, response, raw) => {
    const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) }).parse(JSON.parse(raw));
    const message = (name: string, args: object) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const shown = String(body.messages.find(item => item.role === 'user')?.content);
    const visible = z.object({ services: z.array(z.object({ code: z.string(), id: z.uuidv7() })) }).parse(JSON.parse(shown));
    const cbc = visible.services.find(item => item.code === 'cbc')!;
    const issued = body.messages.filter(item => item.role === 'tool').map(item => { try { return z.object({ reportId: z.uuidv7(), reportVersion: z.int() }).safeParse(JSON.parse(String(item.content))).data; } catch { return undefined; } }).find(Boolean);
    generation++;
    const requested = generation === 1 ? [message('investigate', { serviceId: 'cbc', privateField: 'synthetic-private-model-argument' })] : generation === 2 ? [message('investigate', { serviceId: cbc.id })] : generation === 3 && issued ? [message('read_report', issued), message('acknowledge_report', { ...issued, mode: 'text' })] : generation === 4 && issued ? [message('acknowledge_report', { ...issued, mode: 'text' })] : [];
    if (!requested.length) { openAiText(response, 'Review complete.'); return; }
    const delta = { role: 'assistant', tool_calls: requested.map((item, index) => ({ ...item, id: `call-${generation}-${index}`, index })) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'doctor', model: 'tested-doctor', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'doctor', model: 'tested-doctor', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  }, async baseUrl => withNodeWorkspace(async origin => {
    const clinic = await openPatient((path, init) => fetch(origin + path, init));
    const response = await fetch(`${origin}/api/eval/runs`, { method: 'POST', headers: { ...clinic.headers, ...userProvider(baseUrl) }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 6, clinicianModel: 'tested-doctor', patientModel: 'tested-patient' }) });
    const result = z.object({ trace: z.array(z.looseObject({ operation: z.string(), error: z.string().optional() })) }).parse(await response.json());
    expect(result.trace.filter(item => item.operation === 'investigate')).toMatchObject([{ error: 'INVALID_TOOL_ARGUMENTS', input: { fields: ['serviceId'] } }, { output: { reportVersion: 1 } }]);
    expect(result.trace.filter(item => item.operation === 'acknowledge_report')).toMatchObject([{ error: 'REPORT_REVIEW_REQUIRED' }, { output: { status: 'acknowledged' } }]);
    expect(result.trace.filter(item => item.operation === 'lab.acknowledge')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private-model-argument|synthetic-user-only-key/);
  }, false, { CLINMESH_PORT: '51998', CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_LLM_ALLOWED_BASE_URLS: baseUrl }));
}, 30000);
