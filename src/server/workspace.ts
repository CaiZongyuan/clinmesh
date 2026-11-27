import { Hono } from 'hono';
import { ClinicianAssistant, PatientRuntime, registerPatientOperations, type AgentEnvironment } from '../packages/agent-runtime';
import { permitsProviderKey } from '../packages/agent-protocol';
import { openVoiceSession, voiceBinding, voiceHandshake, voiceModule, type BailianConnect, type VoiceSocket } from '../packages/mod-voice';
import { v7 } from 'uuid';
import { z } from 'zod';
import { installHospitalDataPack, readHospitalDataPack } from '../packages/data-pack';
import { registerClinicalOperations, workspaceSchema } from '../packages/clinical-core';
import { listEncounters, requireEncounter, startEncounter, summarySchema } from '../packages/patient-visit';
import { administer, authorize, checkVersion, CoreError, createVisitorGate, ModuleRegistry, OperationCatalog, permits, registerPlatformOperations, resolveActor, sessionSchema, sessionView, type ClinMeshModule, type Credential, type GateSettings } from '../packages/platform';
import { StoreVersionConflictError, type StorePort } from '../packages/store';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';
import { evaluateEncounter } from './evaluation';
import { evaluationResult, launchEvaluation, recoverEvaluation, type EvaluationHost, type EvaluationLaunch } from './evaluation-host';

export function handleError(error: Error) {
  if (error instanceof CoreError) return Response.json(error.code.startsWith('LLM_') ? { code: error.code, settings: '#model-settings' } : { code: error.code, details: error.details }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ code: 'INVALID_INPUT' }, { status: 400 });
  if (error instanceof StoreVersionConflictError) return Response.json({ code: 'VERSION_CONFLICT' }, { status: 409 });
  return Response.json({ code: 'INTERNAL_ERROR' }, { status: 500 });
}

type SocketConnection = { receive(data: unknown): void; close(): void };
export type UpgradeSocket = (request: Request, connect: (socket: VoiceSocket) => SocketConnection, protocol?: string) => Response | Promise<Response>;
export function createWorkspaceApp(store: StorePort, settings: GateSettings, modules: readonly ClinMeshModule<OperationCatalog>[] = [], environment: AgentEnvironment & { BAILIAN_TOKEN?: string } = {}, background?: (task: Promise<void>) => void, upgrade?: UpgradeSocket, evaluations?: EvaluationHost, connectVoice?: BailianConnect) {
  const app = new Hono<{ Bindings: { credential: Credential; entering: boolean; upgrade?: UpgradeSocket } }>();
  const registry = new ModuleRegistry(modules);
  app.onError(handleError);
  if (modules.some(module => module.id === voiceModule.id)) app.get('/api/voice/session', async context => {
    const binding = voiceBinding.parse(context.req.query());
    await store.read(reader => {
      const actor = resolveActor(reader, context.env.credential, new Date().toISOString());
      authorize(actor, { name: 'voice.session', access: { visitorOnly: true, capabilities: ['assess'] }, moduleId: voiceModule.id });
      if (actor.at.epoch !== binding.epoch) throw new CoreError(409, 'EPOCH_CONFLICT');
      const encounter = requireEncounter(reader, actor.at, binding.encounterId);
      if (encounter.status !== 'active' || encounter.active_practitioner_role !== actor.role.id) throw new CoreError(403, 'ROLE_FORBIDDEN');
    });
    if (!permitsProviderKey(new URL(context.req.url))) throw new CoreError(400, 'VOICE_HTTPS_REQUIRED');
    const open = context.env.upgrade ?? upgrade;
    if (!connectVoice || !open || context.req.header('upgrade')?.toLowerCase() !== 'websocket') return context.json({ code: 'WEBSOCKET_REQUIRED' }, 426);
    const handshake = voiceHandshake(context.req.header('sec-websocket-protocol'));
    return open(context.req.raw, socket => openVoiceSession(socket, connectVoice, handshake.token ?? environment.BAILIAN_TOKEN), handshake.protocol);
  });
  app.post('/api/auth/visitor/enter', async context => {
    if (!context.env.entering) throw new CoreError(401, 'VISITOR_AUTH_REQUIRED');
    const ticket = context.env.credential.ticket;
    const now = new Date().toISOString();
    const pack = BUILTIN_DATA_PACKS['global-general'];
    const roleId = pack.organization.practitionerRoles[0]!.id;
    const result = await store.withTransaction(async tx => {
      const at = installHospitalDataPack(tx, { workspaceId: ticket.workspaceId, expectedEpoch: null, virtualTime: now, recordedAt: now }, pack);
      await registry.initializeEpoch(pack.manifest.enabledModules, tx, at, now, now);
      tx.insert(at, 'visitor_sessions', { id: ticket.id, practitioner_role: roleId, version: 1, revoked: false, expires_at: ticket.expiresAt });
      tx.insert(at, 'audit_events', { id: v7(), actor: ticket.id, practitioner_role: roleId, target_id: at.workspaceId, operation: 'visitor.enter', virtual_at: now, recorded_at: now, outcome: 'applied' });
      return { ...at, roleId, sessionVersion: 1 };
    });
    return context.json(result);
  });
  const catalog = new OperationCatalog();
  const assistant = new ClinicianAssistant(store, catalog, environment);
  app.post('/api/eval/runs', context => launchEvaluation(store, evaluations, context.env.credential, context.req.raw));
  app.get('/api/eval/runs/:id', context => recoverEvaluation(store, evaluations, context.env.credential, context.req.param('id')));
  app.post('/api/assistant/sessions', async context => context.json(await assistant.sessions(context.env.credential, await context.req.json())));
  app.post('/api/assistant/availability', async context => context.json(await assistant.availability(context.env.credential, await context.req.json(), context.req.raw.headers)));
  app.post('/api/assistant/observations', async context => context.json(await assistant.observations(context.env.credential, await context.req.json())));
  app.post('/api/assistant/turn', async context => context.json(await assistant.turn(context.env.credential, await context.req.json(), context.req.raw.headers)));
  app.post('/api/assistant/stop', async context => context.json(await assistant.stop(context.env.credential, await context.req.json())));
  app.get('/api/assistant/bridge', async context => {
    const open = context.env.upgrade ?? upgrade;
    if (!open || context.req.header('upgrade')?.toLowerCase() !== 'websocket') return context.json({ code: 'WEBSOCKET_REQUIRED' }, 426);
    const connect = await assistant.socket(context.env.credential, { ...context.req.query(), thread: Number(context.req.query('thread')) });
    return open(context.req.raw, connect);
  });
  catalog.moduleAvailable = (id, reader, actor) => registry.enabled(actor.enabledModules, reader, actor.at).some(module => module.id === id);
  catalog.guardEncounter = (context, write) => { for (const module of registry.enabled(context.actor.enabledModules)) module.guardEncounter?.(context, write); };
  const patients = new PatientRuntime(store, environment, background);
  registerPatientOperations(catalog, environment);
  app.post('/api/agents/providers/test', async context => context.json(await patients.testProvider(context.env.credential, context.req.raw.headers, await context.req.json())));
  app.get('/api/agents/sessions/:id/events', context => patients.events(context.env.credential, context.req.param('id'), context.req.raw));
  registerPlatformOperations(catalog, { sign: createVisitorGate(settings).sign, modules: registry });
  catalog.command({ name: 'workspace.reset', method: 'POST', path: '/api/workspace/reset', access: administer }, { packId: z.string().optional() }, sessionSchema, async ({ tx, at, actor, expectedVersion, virtualAt, recordedAt }, { packId }) => {
    checkVersion(actor.active.clock_revision, expectedVersion);
    const id = packId ?? tx.list(at, 'data_pack_installations')[0]!.pack_id;
    const nextPack = Object.values(BUILTIN_DATA_PACKS).find(pack => pack.manifest.packId === id);
    if (!nextPack) throw new CoreError(400, 'PACK_NOT_FOUND');
    const next = installHospitalDataPack(tx, { workspaceId: at.workspaceId, expectedEpoch: at.epoch, virtualTime: virtualAt, recordedAt }, nextPack);
    await registry.initializeEpoch(nextPack.manifest.enabledModules, tx, next, virtualAt, recordedAt);
    const roles = nextPack.organization.practitionerRoles;
    const role = roles.find(role => role.id === actor.role.id) ?? roles.find(role => role.capabilities.includes('workspace-admin')) ?? roles[0]!;
    tx.insert(next, 'visitor_sessions', { id: actor.id, practitioner_role: role.id, expires_at: actor.expiresAt, revoked: false, version: 1 });
    return { ...next, roleId: role.id, sessionVersion: 1 };
  });
  catalog.query({ name: 'workspace.read', path: '/api/workspace', access: {} }, workspaceSchema, ({ reader, actor }) => {
    const pack = readHospitalDataPack(reader, actor.at)!;
    const enabled = registry.enabled(actor.enabledModules, reader, actor.at);
    const effective = { ...actor, enabledModules: enabled.map(module => module.id) };
    const operations = catalog.entries.filter(entry => permits(effective, entry)).map(({ name, method, path }) => ({ name, method, path }));
    return { ...sessionView(actor), manifest: pack.manifest, roles: pack.organization.practitionerRoles, cases: pack.cases,
      diagnoses: pack.catalog.diagnoses, packs: Object.values(BUILTIN_DATA_PACKS).map(({ manifest }) => ({ id: manifest.packId, name: manifest.name })),
      virtualTime: actor.active.virtual_time, clockRevision: actor.active.clock_revision, enabledModules: enabled.map(module => module.id),
      tabs: enabled.flatMap(module => module.workbenchTabs ?? []).filter(tab => !tab.readOperation || operations.some(operation => operation.name === tab.readOperation)), operations };
  });
  catalog.command({ name: 'encounter.start', method: 'POST', path: '/api/his/cases/:id/start-encounter', access: { capabilities: ['register', 'assess'] } },
    { language: z.enum(['en', 'zh']).optional() }, z.object({ encounterId: z.uuidv7(), version: z.int() }), (context, input) => {
      const result = startEncounter(context, input.language);
      for (const module of registry.enabled(context.actor.enabledModules, context.tx, context.at)) module.encounterStarted?.(context.tx, context.at, result.encounterId, context.virtualAt, context.recordedAt);
      return { ...result, version: context.tx.get(context.at, 'encounters', result.encounterId)!.version };
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
    const credential = context.env.credential;
    const replyOperation = ['consultation.question', 'consultation.retry', 'consultation.stop'].includes(entry.name);
    const providerHeaders = replyOperation ? context.req.raw.headers : undefined;
    const result = await entry.invoke({ store, credential, targetId, params: context.req.param(), body: () => context.req.json(), providerHeaders });
    if (providerHeaders) {
      const { epoch } = z.object({ epoch: z.uuidv7() }).parse(await context.req.json());
      await patients.admitted(entry.name, result, { workspaceId: credential.ticket.workspaceId, epoch }, targetId, providerHeaders);
    }
    return context.json(result);
  });
  app.notFound(async context => {
    await store.read(reader => resolveActor(reader, context.env.credential, new Date().toISOString()));
    return context.json({ code: 'ROUTE_NOT_FOUND' }, 404);
  });
  return Object.assign(app, {
    async runEvaluation(launch: EvaluationLaunch, request: Request): Promise<Response> {
      try { return Response.json(await evaluateEncounter(store, catalog, registry, environment, launch, request), { status: 201 }); }
      catch (error) { return handleError(error instanceof Error ? error : Error('EVALUATION_FAILED')); }
    },
    evaluationReport: (runId: string) => evaluationResult(store, runId),
  });
}
