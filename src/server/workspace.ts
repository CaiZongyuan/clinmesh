import { Hono } from 'hono';
import { v7 } from 'uuid';
import { z } from 'zod';
import { installHospitalDataPack, readHospitalDataPack } from '../packages/data-pack';
import { registerClinicalOperations, workspaceSchema } from '../packages/clinical-core';
import { listEncounters, startEncounter, summarySchema } from '../packages/patient-visit';
import { administer, authorize, checkVersion, CoreError, createVisitorGate, ModuleRegistry, OperationCatalog, permits, registerPlatformOperations, resolveActor, sessionSchema, sessionView, type ClinMeshModule, type Credential, type GateSettings } from '../packages/platform';
import { StoreVersionConflictError, type StorePort } from '../packages/store';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';

export function handleError(error: Error) {
  if (error instanceof CoreError) return Response.json({ code: error.code }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ code: 'INVALID_INPUT' }, { status: 400 });
  if (error instanceof StoreVersionConflictError) return Response.json({ code: 'VERSION_CONFLICT' }, { status: 409 });
  return Response.json({ code: 'INTERNAL_ERROR' }, { status: 500 });
}

export function createWorkspaceApp(store: StorePort, settings: GateSettings, modules: readonly ClinMeshModule<OperationCatalog>[] = []) {
  const app = new Hono<{ Bindings: { credential: Credential; entering: boolean } }>();
  app.onError(handleError);
  app.post('/api/auth/visitor/enter', async context => {
    if (!context.env.entering) throw new CoreError(401, 'VISITOR_AUTH_REQUIRED');
    const ticket = context.env.credential.ticket;
    const now = new Date().toISOString();
    const pack = BUILTIN_DATA_PACKS['global-general'];
    const roleId = pack.organization.practitionerRoles[0]!.id;
    const result = await store.withTransaction(tx => {
      const at = installHospitalDataPack(tx, { workspaceId: ticket.workspaceId, expectedEpoch: null, virtualTime: now, recordedAt: now }, pack);
      tx.insert(at, 'visitor_sessions', { id: ticket.id, practitioner_role: roleId, version: 1, revoked: false, expires_at: ticket.expiresAt });
      tx.insert(at, 'audit_events', { id: v7(), actor: ticket.id, practitioner_role: roleId, target_id: at.workspaceId, operation: 'visitor.enter', virtual_at: now, recorded_at: now, outcome: 'applied' });
      return { ...at, roleId, sessionVersion: 1 };
    });
    return context.json(result);
  });
  const catalog = new OperationCatalog();
  const registry = new ModuleRegistry(modules);
  registerPlatformOperations(catalog, { sign: createVisitorGate(settings).sign, modules: registry });
  catalog.command({ name: 'workspace.reset', method: 'POST', path: '/api/workspace/reset', access: administer }, { packId: z.string().optional() }, sessionSchema, ({ tx, at, actor, expectedVersion, virtualAt, recordedAt }, { packId }) => {
    checkVersion(actor.active.clock_revision, expectedVersion);
    const id = packId ?? tx.list(at, 'data_pack_installations')[0]!.pack_id;
    const nextPack = Object.values(BUILTIN_DATA_PACKS).find(pack => pack.manifest.packId === id);
    if (!nextPack) throw new CoreError(400, 'PACK_NOT_FOUND');
    const next = installHospitalDataPack(tx, { workspaceId: at.workspaceId, expectedEpoch: at.epoch, virtualTime: virtualAt, recordedAt }, nextPack);
    const roles = nextPack.organization.practitionerRoles;
    const role = roles.find(role => role.id === actor.role.id) ?? roles.find(role => role.capabilities.includes('workspace-admin')) ?? roles[0]!;
    tx.insert(next, 'visitor_sessions', { id: actor.id, practitioner_role: role.id, expires_at: actor.expiresAt, revoked: false, version: 1 });
    return { ...next, roleId: role.id, sessionVersion: 1 };
  });
  catalog.query({ name: 'workspace.read', path: '/api/workspace', access: {} }, workspaceSchema, ({ reader, actor }) => {
    const pack = readHospitalDataPack(reader, actor.at)!;
    const enabled = registry.enabled(actor.enabledModules);
    return { ...sessionView(actor), manifest: pack.manifest, roles: pack.organization.practitionerRoles, cases: pack.cases,
      diagnoses: pack.catalog.diagnoses, packs: Object.values(BUILTIN_DATA_PACKS).map(({ manifest }) => ({ id: manifest.packId, name: manifest.name })),
      virtualTime: actor.active.virtual_time, clockRevision: actor.active.clock_revision, enabledModules: enabled.map(module => module.id), tabs: enabled.flatMap(module => module.workbenchTabs ?? []),
      operations: catalog.entries.filter(entry => permits(actor, entry)).map(({ name, method, path }) => ({ name, method, path })) };
  });
  catalog.command({ name: 'encounter.start', method: 'POST', path: '/api/his/cases/:id/start-encounter', access: { capabilities: ['register', 'assess'] } },
    { language: z.enum(['en', 'zh']).optional() }, z.object({ encounterId: z.uuidv7(), version: z.int() }), (context, input) => {
      const result = startEncounter(context, input.language);
      for (const module of registry.enabled(context.actor.enabledModules)) module.encounterStarted?.(context.tx, context.at, result.encounterId, context.virtualAt, context.recordedAt);
      return result;
    });
  catalog.query({ name: 'encounter.list', path: '/api/his/encounters', access: {} }, z.array(summarySchema), ({ reader, actor }) => listEncounters(reader, actor.at));
  registerClinicalOperations(catalog, registry);
  for (const module of modules) {
    const moduleId = module.kind === 'core' ? undefined : module.id;
    if (module.registerOperations) catalog.contribute(moduleId, registry => module.registerOperations!(registry));
    if (!module.registerRoutes) continue;
    const router = new Hono();
    module.registerRoutes(router);
    for (const route of router.routes) {
      if (route.method !== 'GET') throw Error(`Module writes require the Operation Catalog: ${module.id}`);
      app.get(route.path, async context => {
        await store.read(reader => authorize(resolveActor(reader, context.env.credential, new Date().toISOString()), { name: `${module.id}.route`, access: { visitorOnly: true }, moduleId }));
        return router.fetch(context.req.raw);
      });
    }
  }
  for (const entry of catalog.entries) app.on(entry.method, entry.path, async context => {
    const targetId = context.req.param('id') ?? context.env.credential.ticket.workspaceId;
    const result = await entry.invoke({ store, credential: context.env.credential, targetId, body: () => context.req.json() });
    return context.json(result);
  });
  app.notFound(async context => {
    await store.read(reader => resolveActor(reader, context.env.credential, new Date().toISOString()));
    return context.json({ code: 'ROUTE_NOT_FOUND' }, 404);
  });
  return app;
}
