import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { teachingGate, withNodeWorkspace } from '../../../scripts/testing/node-workspace';
import { executionArm } from '../../packages/agent-runtime';
import { nodePlatform, workerPlatform } from './platform-hosts';
import { platformJourney } from './platform-journey';

beforeAll(() => { execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { windowsHide: true }); }, 90000);

it('completes the workbench, CLI and evaluation journeys on both real hosts and restores each into the opposite fresh SQLite host', async () => {
  const node = await nodePlatform();
  try {
    const worker = await workerPlatform();
    try {
      const nodeToWorker = await platformJourney(node, worker);
      const workerToNode = await platformJourney(worker, node);
      await writeFile('dist/platform-recovery.json', JSON.stringify({ nodeToWorker, workerToNode }, null, 2) + '\n');
    }
    finally { await worker.close(); }
  } finally { await node.close(); }
}, 240000);

it('drives the same two durable agents and clinical objectives through all four installed execution arms', () => withNodeWorkspace(async origin => {
  const entered = await fetch(`${origin}/api/auth/visitor/enter`, { method: 'POST', body: JSON.stringify({ passcode: teachingGate.CLINMESH_VISITOR_PASSCODE }) });
  const { epoch } = z.object({ epoch: z.uuidv7() }).parse(await entered.json());
  const headers = { cookie: entered.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json', 'X-ClinMesh-LLM-Mock': '1' };
  expect((await fetch(`${origin}/api/workspace/role`, { method: 'POST', headers, body: JSON.stringify({ roleId: 'family-clinician', epoch, expectedVersion: 1, idempotencyKey: crypto.randomUUID() }) })).status).toBe(200);
  const runs = new Set<string>();
  for (const arm of executionArm.options) {
    const response = await fetch(`${origin}/api/eval/runs`, { method: 'POST', headers, body: JSON.stringify({ arm, packId: 'global-general', caseId: 'g01', maxTurns: 12, clinicianModel: 'scripted-clinician', patientModel: 'scripted-patient' }) });
    const body = await response.json();
    expect(response.status, `${arm} ${JSON.stringify(body).slice(0, 200)}`).toBe(201);
    const run = z.object({ runId: z.uuidv7(), trace: z.array(z.object({ operation: z.string(), error: z.string().optional() })) }).parse(body);
    expect(JSON.stringify(body.trace)).not.toMatch(/SIM-G01|1991-04-17|"caseTruth"/);
    expect(body, `${arm} ${JSON.stringify(run.trace.filter(row => row.error))}`).toMatchObject({ arm, status: 'completed', patientTurns: 1, error: null, hits: { diagnosis: true, investigations: { matched: 1 }, medications: { matched: 1 } } });
    expect(run.trace.map(item => item.operation)).toEqual(expect.arrayContaining(['consultation.reply', 'diagnosis.confirm', 'lab.acknowledge', 'prescription.sign', 'record.sign', 'encounter.complete']));
    expect(await (await fetch(`${origin}/api/eval/runs/${run.runId}`, { headers })).json()).toEqual(body);
    runs.add(run.runId);
    console.info(`Evaluation ${arm}: ${run.runId} completed, ${run.trace.length} trace entries`);
  }
  expect(runs.size).toBe(4);
}), 240000);
