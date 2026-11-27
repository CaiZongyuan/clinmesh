import { expect, it } from 'vitest';
import { z } from 'zod';
import { createNodeSqliteStore } from '../../store';
import { createApp } from '../../../server/app';
import { createWorkspaceApp } from '../../../server/workspace';
import { builtinModules } from '../../../server/builtin-modules';
import { openPatient } from './patient-fixture';

it('finishes a CAP Evaluation Run with two durable agents, scored facts and a separate active clinician workspace', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const settings = { CLINMESH_VISITOR_PASSCODE: 'test-passcode', CLINMESH_SESSION_SECRET: 'synthetic-evaluation-workspace-signing-secret' };
  try {
    const workspace = createWorkspaceApp(store, settings, builtinModules);
    const app = createApp('node', settings, (request, credential, entering) => workspace.fetch(request, { credential, entering }), builtinModules);
    const http = async (path: string, init?: RequestInit) => app.request(`https://test.example${path}`, init);
    const clinic = await openPatient(http);
    const before = await clinic.read();
    const response = await http('/api/eval/runs', { method: 'POST', headers: { ...clinic.headers, 'X-ClinMesh-LLM-Mock': '1' }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 12, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
    const report = z.looseObject({ epoch: z.uuidv7(), turns: z.int(), error: z.string().nullable(), trace: z.array(z.object({ operation: z.string(), error: z.string().optional() })) }).parse(await response.json());
    expect(report, JSON.stringify({ turns: report.turns, error: report.error, operations: report.trace?.map((action: { operation: string; error?: string }) => [action.operation, action.error]) })).toMatchObject({ status: 'completed', hits: { diagnosis: true, investigations: { matched: 1 }, medications: { matched: 1 } }, redline: false });
    expect(response.status).toBe(201);
    expect(report.epoch).not.toBe(clinic.workspace.epoch);
    expect(report.trace.map((action: { operation: string }) => action.operation)).toEqual(expect.arrayContaining(['consultation.question', 'consultation.reply', 'lab.issue', 'lab.report-now', 'lab.acknowledge', 'diagnosis.confirm', 'prescription.sign', 'record.sign', 'encounter.complete']));
    expect(await clinic.read()).toEqual(before);
    expect((await http(`${clinic.base}/debrief`, { headers: clinic.headers })).status).toBe(403);
    const short = await http('/api/eval/runs', { method: 'POST', headers: { ...clinic.headers, 'X-ClinMesh-LLM-Mock': '1' }, body: JSON.stringify({ packId: 'global-general', caseId: 'g01', maxTurns: 1, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
    expect(await short.json()).toMatchObject({ status: 'incomplete', hits: null, turns: 1 });
  } finally { await store.close(); }
});
