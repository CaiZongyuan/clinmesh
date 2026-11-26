import { v7 } from 'uuid';
import { z } from 'zod';
import { checkVersion, type Actor } from './commands';
import { CoreError, sha256, type Ticket } from './visitor-gate';
import type { OperationCatalog } from './operation-catalog';
import type { ModuleRegistry } from './module-registry';

export const sessionSchema = z.object({ workspaceId: z.uuidv7(), epoch: z.uuidv7(), roleId: z.string(), sessionVersion: z.int() });
export const sessionView = (actor: Actor) => ({ ...actor.at, roleId: actor.role.id, sessionVersion: actor.sessionVersion });
const visitor = { visitorOnly: true };
export const administer = { visitorOnly: true, capabilities: ['workspace-admin'] };
const capabilityResult = z.object({ tokenId: z.uuidv7(), expiresAt: z.iso.datetime(), version: z.int() });
type Dependencies = { sign(ticket: Ticket): Promise<string>; modules: ModuleRegistry<OperationCatalog> };

export function registerPlatformOperations(catalog: OperationCatalog, { sign, modules }: Dependencies) {
  catalog.query({ name: 'session.read', path: '/api/auth/session', access: visitor }, sessionSchema, ({ actor }) => sessionView(actor));
  catalog.command({ name: 'workspace.role', method: 'POST', path: '/api/workspace/role', access: visitor }, { roleId: z.string().min(1) }, sessionSchema, (context, { roleId }) => {
    const { tx, at, actor, expectedVersion } = context;
    if (!actor.roles.some(role => role.id === roleId)) throw new CoreError(400, 'ROLE_NOT_IN_PACK');
    tx.update(at, 'visitor_sessions', actor.id, expectedVersion, { practitioner_role: roleId });
    return { ...at, roleId, sessionVersion: expectedVersion + 1 };
  });
  catalog.command({ name: 'visitor.logout', method: 'POST', path: '/api/auth/logout', access: visitor }, {}, z.object({ loggedOut: z.literal(true) }), ({ tx, at, actor, expectedVersion }) => {
    tx.update(at, 'visitor_sessions', actor.id, expectedVersion, { revoked: true });
    return { loggedOut: true as const };
  });
  catalog.command({ name: 'capability.issue', method: 'POST', path: '/api/workspace/capabilities', access: administer }, {
    roleId: z.string().min(1), allowedOperations: z.array(z.string().min(1)).min(1).max(128), ttlSeconds: z.int().min(1).max(3600),
  }, capabilityResult, (context, input, prepared: { id: string; hash: string; expiresAt: string }) => {
    checkVersion(0, context.expectedVersion);
    const role = context.actor.roles.find(role => role.id === input.roleId);
    if (!role) throw new CoreError(400, 'ROLE_NOT_IN_PACK');
    for (const name of input.allowedOperations) {
      const operation = catalog.require(name);
      if (operation.access.visitorOnly || (operation.moduleId && !context.actor.enabledModules.includes(operation.moduleId)) ||
        (operation.access.capabilities && !operation.access.capabilities.some(capability => role.capabilities.includes(capability)))) throw new CoreError(400, 'INVALID_CAPABILITY_SCOPE');
    }
    context.tx.insert(context.at, 'capability_tokens', { id: prepared.id, token_hash: prepared.hash, practitioner_role: role.id, allowed_operations: [...new Set(input.allowedOperations)], expires_at: prepared.expiresAt, revoked: false, version: 1 });
    return { tokenId: prepared.id, expiresAt: prepared.expiresAt, version: 1 };
  }, async (actor, input) => {
    const id = v7();
    const expiresAt = new Date(Math.min(Date.now() + input.ttlSeconds * 1000, Date.parse(actor.expiresAt))).toISOString();
    const token = await sign({ kind: 'capability', ...actor.at, id, expiresAt });
    return { value: { id, expiresAt, hash: await sha256(token) }, firstResponse: { token } };
  });
  catalog.command({ name: 'capability.revoke', method: 'POST', path: '/api/workspace/capabilities/:id/revoke', access: administer }, {}, z.object({ revoked: z.literal(true) }), ({ tx, at, targetId, expectedVersion }) => {
    if (!tx.get(at, 'capability_tokens', targetId)) throw new CoreError(404, 'CAPABILITY_NOT_FOUND');
    tx.update(at, 'capability_tokens', targetId, expectedVersion, { revoked: true });
    return { revoked: true as const };
  });
  catalog.query({ name: 'workspace.audit', path: '/api/workspace/audit/:id', access: administer }, z.array(z.object({ id: z.uuidv7(), actor: z.string(), practitioner_role: z.string(), operation: z.string(), target_id: z.uuid(), outcome: z.string(), recorded_at: z.iso.datetime(), virtual_at: z.iso.datetime() })), ({ reader, actor, targetId }) => reader.list({ workspaceId: actor.at.workspaceId, epoch: targetId }, 'audit_events'));
  catalog.command({ name: 'workspace.advance-time', method: 'POST', path: '/api/workspace/advance-time', access: administer }, { to: z.iso.datetime() }, z.object({ virtualTime: z.iso.datetime(), clockRevision: z.int() }), async (context, { to }) => {
    const { tx, at, actor, expectedVersion } = context;
    const delta = Date.parse(to) - Date.parse(actor.active.virtual_time);
    if (delta <= 0 || delta > 366 * 86_400_000) throw new CoreError(400, 'VIRTUAL_TIME_OUT_OF_RANGE');
    tx.updateEpoch(at, expectedVersion, { virtual_time: to });
    const enabled = modules.enabled(actor.enabledModules);
    if (enabled.some(module => module.midnight)) {
      const timezone = z.string().parse(tx.list(at, 'data_pack_installations')[0]?.manifest.timezone);
      for (const date of crossedMidnights(context.virtualAt, to, timezone)) {
        for (const module of enabled) await module.midnight?.(tx, at, date);
      }
    }
    return { virtualTime: to, clockRevision: expectedVersion + 1 };
  });
}

function* crossedMidnights(from: string, to: string, timeZone: string) {
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const start = Date.parse(calendar.format(new Date(from)));
  const end = Date.parse(calendar.format(new Date(to)));
  for (let midnight = start + 86_400_000; midnight <= end; midnight += 86_400_000) yield new Date(midnight).toISOString().slice(0, 10);
}
