import { v7 } from 'uuid';
import { z } from 'zod';
import { canonicalJson, type StorePort, type StoreReader, type StoreScope, type StoreTx } from '../../store';
import { CoreError, sha256, type Credential } from './visitor-gate';
import type { ClinicalQualityIntent } from './clinical-quality';

export const commandEnvelope = z.object({ epoch: z.uuidv7(), idempotencyKey: z.string().trim().min(1).max(160).refine(key => !key.startsWith('patient-reply:')), expectedVersion: z.int().nonnegative() });
export type CommandEnvelope = z.infer<typeof commandEnvelope>;
export const localizedName = z.object({ en: z.string(), zh: z.string() });
export const practitionerRole = z.object({ id: z.string(), name: localizedName, capabilities: z.array(z.string()) });
const organization = z.object({ practitionerRoles: z.array(practitionerRole) });
export type Access = { capabilities?: readonly string[]; visitorOnly?: boolean };
export type Actor = ReturnType<typeof resolveActor>;
export type EncounterWrite = { encounterId: string; kind: 'clinical' | 'record' | 'complete' | 'diagnose' } | { encounterId: string; kind: 'accept-investigation'; orderId: string };
export type CommandContext = { tx: StoreTx; at: StoreScope; actor: Actor; targetId: string; expectedVersion: number; virtualAt: string; recordedAt: string; guardEncounter?(write: EncounterWrite): void; moduleEnabled?(id: string): boolean; checkClinicalQuality?(intent: ClinicalQualityIntent, clinicalOverride?: unknown): readonly string[] | void };
export type ClinicalQualityGate = (context: CommandContext, intent: ClinicalQualityIntent, clinicalOverride: unknown, operation: string) => readonly string[] | void;
export type Route = { name: string; method: 'GET' | 'PUT' | 'POST'; path: string; access: Access; moduleId?: string };

export function resolveActor(reader: StoreReader, credential: Credential, now: string) {
  const { ticket, tokenHash } = credential;
  const active = reader.listEpochs(ticket.workspaceId).find(epoch => epoch.status === 'active');
  const denied = () => new CoreError(401, 'VISITOR_AUTH_REQUIRED');
  if (!active || Date.parse(ticket.expiresAt) <= Date.parse(now)) throw denied();
  const at = { workspaceId: ticket.workspaceId, epoch: active.epoch };
  const session = ticket.kind === 'visitor' ? reader.get(at, 'visitor_sessions', ticket.id) : reader.get(at, 'capability_tokens', ticket.id);
  if (!session || session.revoked || Date.parse(session.expires_at) <= Date.parse(now)) throw denied();
  if (ticket.kind === 'capability' && (ticket.epoch !== active.epoch || !('token_hash' in session) || session.token_hash !== tokenHash)) throw denied();
  const [pack] = reader.list(at, 'data_pack_installations');
  const roles = organization.parse(pack?.organization).practitionerRoles;
  const role = roles.find(item => item.id === session.practitioner_role);
  if (!role) throw denied();
  return { at, id: ticket.id, kind: ticket.kind, role, roles, expiresAt: session.expires_at, sessionVersion: session.version,
    allowedOperations: 'allowed_operations' in session ? z.array(z.string()).parse(session.allowed_operations) : undefined, active,
    enabledModules: z.object({ enabledModules: z.array(z.string()) }).parse(pack?.manifest).enabledModules };
}

export function permits(actor: Actor, route: Pick<Route, 'name' | 'access' | 'moduleId'>) {
  return (!route.moduleId || actor.enabledModules.includes(route.moduleId)) && (!route.access.visitorOnly || actor.kind === 'visitor') &&
    (!actor.allowedOperations || actor.allowedOperations.includes(route.name)) && (!route.access.capabilities || route.access.capabilities.some(capability => actor.role.capabilities.includes(capability)));
}
export function authorize(actor: Actor, route: Pick<Route, 'name' | 'access' | 'moduleId'>) {
  if (route.moduleId && !actor.enabledModules.includes(route.moduleId)) throw new CoreError(404, 'MODULE_DISABLED');
  if (!permits(actor, route)) throw new CoreError(403, 'ROLE_FORBIDDEN');
}

export function checkVersion(actual: number, expected: number) {
  if (actual !== expected) throw new CoreError(409, 'VERSION_CONFLICT');
}

export async function executeCommand(store: StorePort, credential: Credential, route: Route, targetId: string, input: CommandEnvelope, apply: (context: CommandContext) => z.core.util.JSONType | Promise<z.core.util.JSONType>) {
  const requestHash = await sha256(canonicalJson({ actor: credential.ticket.id, targetId, input }));
  return store.withTransaction(async tx => {
    const recordedAt = new Date().toISOString();
    const actor = resolveActor(tx, credential, recordedAt);
    authorize(actor, route);
    const at = { workspaceId: actor.at.workspaceId, epoch: input.epoch };
    const receipt = tx.findCommandReceipt(at, input.idempotencyKey);
    if (receipt) {
      if (receipt.operation !== route.name || receipt.request_hash !== requestHash) throw new CoreError(409, 'IDEMPOTENCY_CONFLICT');
      return { replay: true, result: receipt.result };
    }
    if (actor.at.epoch !== input.epoch) throw new CoreError(409, 'EPOCH_CONFLICT');
    const virtualAt = actor.active.virtual_time;
    const result = await apply({ tx, at, actor, targetId, virtualAt, recordedAt, expectedVersion: input.expectedVersion });
    tx.insert(at, 'audit_events', { id: v7(), actor: actor.id, practitioner_role: actor.role.id, operation: route.name, target_id: targetId, outcome: 'applied', virtual_at: virtualAt, recorded_at: recordedAt });
    tx.recordCommandReceipt(at, { id: v7(), operation: route.name, idempotency_key: input.idempotencyKey, request_hash: requestHash, result, recorded_at: recordedAt });
    return { replay: false, result };
  });
}
