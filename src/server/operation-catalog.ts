import { z } from 'zod';
import { registerPatientOperations, type AgentEnvironment } from '../packages/agent-runtime';
import { registerClinicalOperations, workspaceSchema } from '../packages/clinical-core';
import { installHospitalDataPack, readHospitalDataPack } from '../packages/data-pack';
import { clinicalCaseIdSchema } from '../packages/store';
import { listEncounters, startEncounter, summarySchema } from '../packages/patient-visit';
import { administer, checkVersion, CoreError, createVisitorGate, ModuleRegistry, OperationCatalog, permits, registerPlatformOperations, sessionSchema, sessionView, type ClinMeshModule, type GateSettings } from '../packages/platform';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';

export function createOperationCatalog(modules: readonly ClinMeshModule<OperationCatalog>[], settings: GateSettings = {}, environment: AgentEnvironment = {}) {
  const registry = new ModuleRegistry(modules);
  const catalog = new OperationCatalog();
  catalog.moduleAvailable = (id, reader, actor) => registry.enabled(actor.enabledModules, reader, actor.at).some(module => module.id === id);
  catalog.guardEncounter = (context, write) => { for (const module of registry.enabled(context.actor.enabledModules)) module.guardEncounter?.(context, write); };
  catalog.clinicalQuality = (context, intent, override, operation) => registry.enabled(context.actor.enabledModules, context.tx, context.at).flatMap(module => module.clinicalQuality?.(context, intent, override, operation) ?? []);
  registerPatientOperations(catalog, environment);
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
  catalog.command({ name: 'encounter.start', method: 'POST', path: '/api/his/cases/:id/start-encounter', pathParams: { id: clinicalCaseIdSchema }, access: { capabilities: ['register', 'assess'] } },
    { language: z.enum(['en', 'zh']).optional() }, z.object({ encounterId: z.uuidv7(), version: z.int() }), (context, input) => {
      const result = startEncounter(context, input.language);
      for (const module of registry.enabled(context.actor.enabledModules, context.tx, context.at)) module.encounterStarted?.(context.tx, context.at, result.encounterId, context.virtualAt, context.recordedAt);
      return { ...result, version: context.tx.get(context.at, 'encounters', result.encounterId)!.version };
    });
  catalog.query({ name: 'encounter.list', path: '/api/his/encounters', access: {} }, z.array(summarySchema), ({ reader, actor }) => listEncounters(reader, actor.at));
  registerClinicalOperations(catalog, registry);
  for (const module of modules) if (module.registerOperations) catalog.contribute(module.kind === 'core' ? undefined : module.id, module.registerOperations.bind(module));
  return { catalog, registry };
}
