import { v7 } from 'uuid';
import { z } from 'zod';
import { authorize, CoreError, resolveActor, sha256, type Credential } from '../packages/platform';
import type { StorePort, StoreScope } from '../packages/store';

export const evaluationSpec = z.strictObject({ packId: z.string().min(1), caseId: z.string().min(1).max(128), maxTurns: z.int().min(1).max(32), clinicianModel: z.string().regex(/^[\w./:-]{1,160}$/), patientModel: z.string().regex(/^[\w./:-]{1,160}$/) });
export const evaluationLaunch = z.strictObject({ runId: z.uuidv7(), virtualTime: z.iso.datetime(), expiresAt: z.iso.datetime(), spec: evaluationSpec });
export type EvaluationLaunch = z.infer<typeof evaluationLaunch>;
export type EvaluationHost = { start(launch: EvaluationLaunch, request: Request): Promise<Response>; read(runId: string): Promise<Response> };
const access = { visitorOnly: true, capabilities: ['assess', 'workspace-admin'] };
export async function launchEvaluation(store: StorePort, host: EvaluationHost | undefined, credential: Credential, request: Request) {
  const spec = evaluationSpec.parse(await request.json());
  if (!host) throw new CoreError(503, 'EVALUATION_HOST_UNAVAILABLE');
  const owner = await store.read(reader => {
    const recordedAt = new Date().toISOString();
    const actor = resolveActor(reader, credential, recordedAt);
    authorize(actor, { name: 'evaluation.start', access });
    return { at: actor.at, actorId: actor.id, roleId: actor.role.id, recordedAt, virtualTime: actor.active.virtual_time, expiresAt: actor.expiresAt };
  });
  const runId = v7();
  const headers = new Headers();
  for (const [name, value] of request.headers) if (name.toLowerCase().startsWith('x-clinmesh-llm-')) headers.set(name, value);
  const result = await host.start({ runId, spec, virtualTime: owner.virtualTime, expiresAt: owner.expiresAt }, new Request('https://evaluation.internal/', { headers }));
  if (result.ok) await store.withTransaction(tx => tx.insert(owner.at, 'audit_events', { id: runId, actor: owner.actorId, practitioner_role: owner.roleId, target_id: runId, operation: 'evaluation.start', virtual_at: owner.virtualTime, recorded_at: owner.recordedAt, outcome: 'applied' }));
  return result;
}
export async function recoverEvaluation(store: StorePort, host: EvaluationHost | undefined, credential: Credential, id: string) {
  const runId = z.uuidv7().parse(id);
  await store.read(reader => {
    const actor = resolveActor(reader, credential, new Date().toISOString());
    authorize(actor, { name: 'evaluation.read', access });
    const owned = reader.listEpochs(actor.at.workspaceId).some(epoch => {
      const event = reader.get({ workspaceId: actor.at.workspaceId, epoch: epoch.epoch }, 'audit_events', runId);
      return event?.operation === 'evaluation.start' && event.actor === actor.id && event.target_id === runId;
    });
    if (!owned) throw new CoreError(404, 'EVALUATION_NOT_FOUND');
  });
  if (!host) throw new CoreError(503, 'EVALUATION_HOST_UNAVAILABLE');
  return host.read(runId);
}
export async function saveEvaluationResult(store: StorePort, at: StoreScope, report: unknown) {
  const result = z.json().parse(report);
  const requestHash = await sha256(at.workspaceId);
  await store.withTransaction(tx => tx.recordCommandReceipt(at, { id: v7(), operation: 'evaluation.report', idempotency_key: `evaluation:${at.workspaceId}`, request_hash: requestHash, result, recorded_at: new Date().toISOString() }));
  return result;
}
export function evaluationResult(store: StorePort, id: string) {
  const runId = z.uuidv7().parse(id);
  return store.read(reader => {
    const epoch = reader.listEpochs(runId).find(item => item.status === 'active');
    if (!epoch) return Response.json({ code: 'EVALUATION_NOT_FOUND' }, { status: 404 });
    const receipt = reader.findCommandReceipt({ workspaceId: runId, epoch: epoch.epoch }, `evaluation:${runId}`);
    return receipt ? Response.json(receipt.result) : Response.json({ runId, epoch: epoch.epoch, status: 'pending' }, { status: 202 });
  });
}
