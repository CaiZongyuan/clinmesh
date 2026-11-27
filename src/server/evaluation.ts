import { v7 } from 'uuid';
import { z } from 'zod';
import { receiptSchema } from '../packages/agent-protocol';
import { PatientRuntime, resolveAgentProvider, runEvaluationDoctor, type AgentEnvironment, type EvaluationAction } from '../packages/agent-runtime';
import { debriefSchema, encounterViewSchema } from '../packages/clinical-core';
import { installHospitalDataPack, type Coding } from '../packages/data-pack';
import { issueReceipt, labViewSchema } from '../packages/mod-lab';
import { prescribingViewSchema } from '../packages/mod-pharmacy';
import { authorize, CoreError, resolveActor, type Credential, type ModuleRegistry, type OperationCatalog } from '../packages/platform';
import type { StorePort } from '../packages/store';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';

const requestSchema = z.strictObject({ packId: z.string().min(1), caseId: z.string().min(1).max(128), maxTurns: z.int().min(1).max(32), clinicianModel: z.string().regex(/^[\w./:-]{1,160}$/), patientModel: z.string().regex(/^[\w./:-]{1,160}$/) });
type Trace = { operation: string; targetId: string; input: object; output?: unknown; error?: string; elapsedMs: number };
const codingKey = (item: Coding) => JSON.stringify([item.codeSystem, item.code]);
function hits(expected: Coding[], actual: Coding[]) {
  const submitted = new Set(actual.map(codingKey));
  const services = Array.from(new Map(expected.map(item => [codingKey(item), item])).values());
  return { expected: services.length, matched: services.filter(item => submitted.has(codingKey(item))).length, missing: services.filter(item => !submitted.has(codingKey(item))) };
}
export async function evaluateEncounter(store: StorePort, catalog: OperationCatalog, modules: ModuleRegistry<OperationCatalog>, environment: AgentEnvironment, visitor: Credential, raw: unknown, request: Request) {
  const owner = await store.read(reader => {
    const actor = resolveActor(reader, visitor, new Date().toISOString());
    authorize(actor, { name: 'evaluation.start', access: { visitorOnly: true, capabilities: ['assess', 'workspace-admin'] } });
    return actor;
  });
  const input = requestSchema.parse(raw);
  const pack = Object.values(BUILTIN_DATA_PACKS).find(pack => pack.manifest.packId === input.packId);
  if (!pack) throw new CoreError(404, 'PACK_NOT_FOUND');
  const modelHeaders = (model: string) => { const headers = new Headers(request.headers); headers.set('X-ClinMesh-LLM-Model', model); return headers; };
  const clinician = resolveAgentProvider(modelHeaders(input.clinicianModel), environment, 'clinician');
  const patientHeaders = modelHeaders(input.patientModel);
  const patientConfig = resolveAgentProvider(patientHeaders, environment, 'patient');
  if ([clinician, patientConfig].some(provider => provider.apiKey && JSON.stringify(input).includes(provider.apiKey))) throw new CoreError(400, 'LLM_SECRET_IN_INPUT');
  const started = Date.now();
  const runId = v7();
  const role = pack.organization.practitionerRoles.find(role => role.capabilities.includes('assess') && role.capabilities.includes('sign'));
  if (!role) throw new CoreError(409, 'RESPONSIBLE_ROLE_UNAVAILABLE');
  const credential: Credential = { ticket: { kind: 'visitor', id: v7(), workspaceId: runId, expiresAt: owner.expiresAt } };
  const { at, caseId } = await store.withTransaction(async tx => {
    const recordedAt = new Date(started).toISOString();
    const at = installHospitalDataPack(tx, { workspaceId: runId, expectedEpoch: null, virtualTime: owner.active.virtual_time, recordedAt }, pack);
    const target = tx.list(at, 'clinical_cases').find(item => item.case_key === input.caseId || item.id === input.caseId);
    if (!target) throw new CoreError(404, 'CASE_NOT_FOUND');
    await modules.initializeEpoch(pack.manifest.enabledModules, tx, at, owner.active.virtual_time, recordedAt);
    tx.insert(at, 'visitor_sessions', { id: credential.ticket.id, practitioner_role: role.id, version: 1, expires_at: owner.expiresAt, revoked: false });
    return { at, caseId: target.id };
  });
  const trace: Trace[] = [];
  const signal = request.signal;
  async function call(operation: string, targetId: string, expectedVersion = 0, fields: object = {}) {
    if (signal.aborted) throw new CoreError(409, 'EVALUATION_STOPPED');
    const entry = catalog.require(operation);
    const action: Trace = { operation, targetId, input: fields, elapsedMs: Date.now() - started };
    trace.push(action);
    try {
      const result = await entry.invoke({ store, credential, targetId, body: async () => ({ epoch: at.epoch, expectedVersion, idempotencyKey: v7(), ...fields }), providerHeaders: operation === 'consultation.question' ? patientHeaders : undefined });
      if (entry.method !== 'GET') action.output = result;
      return result;
    } catch (error) { action.error = error instanceof CoreError ? error.code : 'INVALID_INPUT'; throw error; }
  }
  const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await call('encounter.start', caseId, 0, { language: 'en' }));
  const sessionId = v7();
  await store.withTransaction(tx => tx.insert(at, 'pi_sessions', { id: sessionId, encounter_id: encounterId, agent: 'clinician' }));
  const patient = new PatientRuntime(store, environment);
  const encounter = async () => encounterViewSchema.parse(await call('encounter.read', encounterId));
  const lab = async () => labViewSchema.parse(await call('lab.read', encounterId));
  const pharmacy = async () => prescribingViewSchema.parse(await call('prescription.read', encounterId));
  const has = (operation: string) => catalog.entries.some(entry => entry.name === operation && (!entry.moduleId || pack.manifest.enabledModules.includes(entry.moduleId)));
  const [visit, available, prescribing] = await Promise.all([encounter(), has('lab.read') ? lab() : undefined, has('prescription.read') ? pharmacy() : undefined]);
  async function perform(action: EvaluationAction) {
    const visit = await encounter();
    if (visit.status !== 'active') throw new CoreError(409, 'ENCOUNTER_COMPLETED');
    switch (action.name) {
      case 'ask_patient': {
        const receipt = receiptSchema.parse(await call('consultation.question', encounterId, visit.version, { content: action.args.question, channel: 'text' }));
        await patient.admitted('consultation.question', receipt, at, encounterId, patientHeaders);
        const events = await patient.events(credential, receipt.sessionId, new Request(`https://evaluation.invalid/events?questionId=${receipt.turnId}`, { headers: patientHeaders }));
        await events.text();
        const reply = (await encounter()).turns.at(-1);
        if (reply?.speaker !== 'patient') throw new CoreError(502, 'LLM_PROVIDER_FAILED');
        trace.push({ operation: 'consultation.reply', input: { questionId: receipt.turnId }, targetId: encounterId, output: reply.content, elapsedMs: Date.now() - started });
        return reply.content;
      }
      case 'investigate': {
        const view = await lab();
        const service = view.services.find(item => item.code === action.args.serviceCode);
        if (!service) throw new CoreError(400, 'SERVICE_NOT_IN_CATALOG');
        await call('lab.save-draft', encounterId, view.draft.version, { serviceIds: [service.id] });
        const { draft } = await lab();
        const issued = issueReceipt.parse(await call('lab.issue', encounterId, draft.version, { items: draft.items })).results[0];
        if (!issued || !('orderId' in issued)) throw new CoreError(409, 'INVESTIGATION_NOT_ISSUED');
        let version = 1;
        for (const operation of ['lab.accept', 'lab.start', 'lab.report-now']) version = z.object({ version: z.int() }).parse(await call(operation, issued.orderId, version)).version;
        const report = (await lab()).orders.find(item => item.id === issued.orderId)?.reports.at(-1);
        if (!report) throw new CoreError(409, 'REPORT_UNAVAILABLE');
        await call('lab.acknowledge', report.id, version, { reportVersion: report.version });
        return { service: service.display.en, summary: report.summary.en, observations: report.observations };
      }
      case 'diagnose': {
        const draft = z.object({ version: z.int() }).parse(await call('diagnosis.draft', encounterId, visit.version, { diagnoses: [{ ...action.args, primary: true }] }));
        return call('diagnosis.confirm', encounterId, draft.version);
      }
      case 'prescribe': return call('prescription.sign', encounterId, visit.version, { lines: [action.args] });
      case 'no_medication': return call('prescription.no-medication', encounterId, visit.version, action.args);
      case 'sign_record': {
        const draft = z.object({ version: z.int(), draftVersion: z.int() }).parse(await call('record.draft', encounterId, visit.version, { fields: Object.fromEntries(action.args.fields.map(item => [item.id, item.text])), expectedDraftVersion: visit.draftVersion }));
        return call('record.sign', encounterId, draft.version, { expectedDraftVersion: draft.draftVersion });
      }
      case 'complete': return call('encounter.complete', encounterId, visit.version);
    }
  }
  const presentation = { opening: visit.turns[0]!.content, priorHistory: visit.priorHistory, vitals: visit.triageVitals, template: visit.template.map(field => field.id), diagnoses: pack.catalog.diagnoses.map(item => ({ codeSystem: item.codeSystem, code: item.code, name: item.display.en })), services: (available?.services ?? []).map(item => ({ code: item.code, name: item.display.en })), drugs: (prescribing?.catalog ?? []).map(item => ({ codeSystem: item.codeSystem, code: item.code, name: item.display.en, dose: item.inpatientDoseBasis.amount, routeCode: item.routeCodes.default })) };
  const doctor = await runEvaluationDoctor(store, at, sessionId, clinician, presentation, input.maxTurns, perform, signal);
  const final = await encounter();
  const completed = final.status === 'completed';
  const debrief = completed ? debriefSchema.parse(await catalog.require('encounter.debrief').invoke({ store, credential, targetId: encounterId, body: async () => ({}) })) : undefined;
  const truth = debrief?.caseTruth;
  const reported = available ? await lab() : undefined;
  const medications = prescribing ? await pharmacy() : undefined;
  const patientCalls = await store.read(reader => reader.list(at, 'agent_model_calls', { session_id: encounterId }));
  const primary = final.diagnosisRevisions.at(-1)?.diagnoses.find(item => item.primary);
  return { runId, ...at, packId: pack.manifest.packId, packVersion: pack.manifest.version, caseId: input.caseId, encounterId, status: completed ? 'completed' : 'incomplete', clinicianModel: clinician.model, patientModel: patientConfig.model,
    durationMs: Date.now() - started, turns: doctor.turns, patientTurns: final.turns.filter(turn => turn.speaker === 'clinician').length, maxTurns: input.maxTurns, error: doctor.error,
    tokens: { clinician: { input: doctor.inputTokens, output: doctor.outputTokens }, patient: { input: patientCalls.reduce((sum, call) => sum + call.input_tokens, 0), output: patientCalls.reduce((sum, call) => sum + call.output_tokens, 0) } },
    redline: trace.some(action => /ALLERGY|CONTRAINDICAT|QUALITY_RED|TIER_1|PRESCRIPTION_.*(?:CONFLICT|LIMIT)/.test(action.error ?? '')), trace,
    hits: truth ? { diagnosis: Boolean(primary && codingKey(primary) === codingKey(truth.primaryDiagnosis)), investigations: hits(truth.results.map(result => result.service), reported?.orders.flatMap(order => order.reports.length ? reported.services.filter(service => service.id === order.serviceId) : []) ?? []), medications: hits(truth.expectedMedications ?? [], medications?.prescriptions.filter(item => item.status !== 'withdrawn').flatMap(item => item.lines) ?? []) } : null };
}
