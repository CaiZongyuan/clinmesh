import { v7 } from 'uuid';
import { z } from 'zod';
import { receiptSchema, replyEvent } from '../packages/agent-protocol';
import { clinicianTool, openExecutionEnvironment, PatientRuntime, resolveAgentProvider, runEvaluationDoctor, type AgentEnvironment, type EvaluationAction, type ExecutionEnvironments } from '../packages/agent-runtime';
import { readCompletedDebrief, encounterViewSchema } from '../packages/clinical-core';
import { installHospitalDataPack, type Coding } from '../packages/data-pack';
import { prescribingViewSchema } from '../packages/mod-pharmacy';
import { CoreError, permits, resolveActor, type Credential, type ModuleRegistry, type OperationCatalog } from '../packages/platform';
import type { StorePort } from '../packages/store';
import { BUILTIN_DATA_PACKS } from './builtin-data-packs';
import { evaluationLaunch, saveEvaluationResult, type EvaluationLaunch } from './evaluation-host';
import { evaluationStudies } from './evaluation-studies';

type Trace = { role: string; operation: string; targetId: string; input: object; output?: unknown; error?: string; hit?: boolean; details?: Readonly<Record<string, string | number>>; elapsedMs: number };
const codingKey = (item: Coding) => JSON.stringify([item.codeSystem, item.code]);
function hits(expected: Coding[], actual: Coding[]) {
  const submitted = new Set(actual.map(codingKey));
  const services = Array.from(new Map(expected.map(item => [codingKey(item), item])).values());
  return { expected: services.length, matched: services.filter(item => submitted.has(codingKey(item))).length, missing: services.filter(item => !submitted.has(codingKey(item))) };
}
export async function evaluateEncounter(store: StorePort, catalog: OperationCatalog, modules: ModuleRegistry<OperationCatalog>, environment: AgentEnvironment, launch: EvaluationLaunch, request: Request, environments: ExecutionEnvironments) {
  const { runId, expiresAt, virtualTime, spec: input } = evaluationLaunch.parse(launch);
  const pack = Object.values(BUILTIN_DATA_PACKS).find(pack => pack.manifest.packId === input.packId);
  if (!pack) throw new CoreError(404, 'PACK_NOT_FOUND');
  const modelHeaders = (model: string) => { const headers = new Headers(request.headers); headers.set('X-ClinMesh-LLM-Model', model); return headers; };
  const clinician = resolveAgentProvider(modelHeaders(input.clinicianModel), environment, 'clinician');
  const patientHeaders = modelHeaders(input.patientModel);
  const patientConfig = resolveAgentProvider(patientHeaders, environment, 'patient');
  if ([clinician, patientConfig].some(provider => provider.apiKey && JSON.stringify(input).includes(provider.apiKey))) throw new CoreError(400, 'LLM_SECRET_IN_INPUT');
  const started = Date.now();
  const role = pack.organization.practitionerRoles.find(role => role.capabilities.includes('assess') && role.capabilities.includes('sign'));
  if (!role) throw new CoreError(409, 'RESPONSIBLE_ROLE_UNAVAILABLE');
  const credential: Credential = { ticket: { kind: 'visitor', id: v7(), workspaceId: runId, expiresAt } };
  const { at, caseId } = await store.withTransaction(async tx => {
    const recordedAt = new Date(started).toISOString();
    const at = installHospitalDataPack(tx, { workspaceId: runId, expectedEpoch: null, virtualTime, recordedAt }, pack);
    const target = tx.list(at, 'clinical_cases').find(item => item.case_key === input.caseId || item.id === input.caseId);
    if (!target) throw new CoreError(404, 'CASE_NOT_FOUND');
    await modules.initializeEpoch(pack.manifest.enabledModules, tx, at, virtualTime, recordedAt);
    tx.insert(at, 'visitor_sessions', { id: credential.ticket.id, practitioner_role: role.id, version: 1, expires_at: expiresAt, revoked: false });
    return { at, caseId: target.id };
  });
  const trace: Trace[] = [];
  const signal = request.signal;
  const actor = await store.read(reader => resolveActor(reader, credential, new Date().toISOString()));
  const allowed = catalog.entries.filter(entry => permits(actor, entry) && (entry.assistantRead === 'encounter' || /^(workspace\.read|encounter\.(?:start|read|complete)|consultation\.question|diagnosis\.(?:draft|confirm)|record\.(?:draft|sign)|prescription\.(?:read|sign|no-medication)|(?:lab|imaging|pathology)\.(?:read|save-draft|issue|accept|start|report-now|acknowledge))$/.test(entry.name)));
  const has = (operation: string) => allowed.some(entry => entry.name === operation);
  let boundEncounter: string | undefined;
  const executor = await openExecutionEnvironment(input.arm, { roleId: role.id, operations: allowed.map(entry => entry.contract), encounterId: () => boundEncounter,
    async invoke(name, fields) {
      if (signal.aborted) throw new CoreError(409, 'EVALUATION_STOPPED');
      const entry = allowed.find(entry => entry.name === name);
      if (!entry) throw new CoreError(403, 'ROLE_FORBIDDEN');
      const args = entry.contract.inputSchema.parse(fields);
      const { id, ...body } = args;
      if (name === 'encounter.start' && (id !== caseId || boundEncounter)) throw new CoreError(403, 'EVALUATION_CASE_MISMATCH');
      return entry.invoke({ store, credential, targetId: typeof id === 'string' ? id : runId, body: async () => body, providerHeaders: name === 'consultation.question' ? patientHeaders : undefined });
    },
  }, environments);
  try {
  async function call(operation: string, targetId: string, expectedVersion = 0, fields: object = {}) {
    if (signal.aborted) throw new CoreError(409, 'EVALUATION_STOPPED');
    const entry = catalog.require(operation);
    const action: Trace = { role: role!.id, operation, targetId, input: fields, elapsedMs: Date.now() - started };
    trace.push(action);
    try {
      const result = await executor.invoke(operation, { ...(entry.contract.pathFields.includes('id') && { id: targetId }), ...(entry.method !== 'GET' && { epoch: at.epoch, expectedVersion, idempotencyKey: v7(), ...fields }) });
      action.output = result;
      return result;
    } catch (error) { action.error = error instanceof CoreError ? error.code : 'INVALID_INPUT'; if (error instanceof CoreError && error.details) action.details = error.details; throw error; }
  }
  const { encounterId } = z.object({ encounterId: z.uuidv7() }).parse(await call('encounter.start', caseId, 0, { language: 'en' }));
  boundEncounter = encounterId;
  const sessionId = v7();
  await store.withTransaction(tx => tx.insert(at, 'pi_sessions', { id: sessionId, encounter_id: encounterId, agent: 'clinician' }));
  const patient = new PatientRuntime(store, environment);
  const encounter = async () => encounterViewSchema.parse(await call('encounter.read', encounterId));
  const pharmacy = async () => prescribingViewSchema.parse(await call('prescription.read', encounterId));
  const [visit, studies, prescribing] = await Promise.all([encounter(), evaluationStudies(store, at, encounterId, call, has), has('prescription.read') ? pharmacy() : undefined]);
  let patientFailure: string | null = null;
  async function perform(action: EvaluationAction, delivered: ReadonlySet<string>) {
    const visit = await encounter();
    if (visit.status !== 'active') throw new CoreError(409, 'ENCOUNTER_COMPLETED');
    switch (action.name) {
      case 'ask_patient': {
        const receipt = receiptSchema.parse(await call('consultation.question', encounterId, visit.version, { content: action.args.question, channel: 'text' }));
        await patient.admitted('consultation.question', receipt, at, encounterId, patientHeaders);
        const events = await patient.events(credential, receipt.sessionId, new Request(`https://evaluation.invalid/events?questionId=${receipt.turnId}`, { headers: patientHeaders }));
        const frames = (await events.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => replyEvent.parse(JSON.parse(line.slice(6))));
        const terminal = frames.findLast(frame => frame.questionId === receipt.turnId && frame.attempt === receipt.attempt && ['done', 'failed', 'stopped'].includes(frame.status));
        if (terminal?.status !== 'done') {
          const code = terminal?.code && /^(?:LLM_[A-Z_]+|PATIENT_REPLY_STOPPED)$/.test(terminal.code) ? terminal.code : terminal?.status === 'stopped' ? 'PATIENT_REPLY_STOPPED' : 'LLM_PROVIDER_FAILED';
          patientFailure = code;
          trace.push({ role: 'patient', operation: 'consultation.reply', input: { questionId: receipt.turnId, attempt: receipt.attempt }, targetId: encounterId, error: code, elapsedMs: Date.now() - started });
          throw new CoreError(502, code);
        }
        const reply = (await encounter()).turns.at(-1);
        if (reply?.speaker !== 'patient') throw new CoreError(502, 'LLM_PROVIDER_FAILED');
        trace.push({ role: 'patient', operation: 'consultation.reply', input: { questionId: receipt.turnId }, targetId: encounterId, output: reply.content, elapsedMs: Date.now() - started });
        return reply.content;
      }
      case 'investigate': return studies.investigate(action.args.serviceId, visit.version, action.args.priorSurgeryId);
      case 'read_report': return studies.report(action.args.reportId, action.args.reportVersion);
      case 'acknowledge_report': return studies.acknowledge(action.args.reportId, action.args.reportVersion, action.args.mode, delivered);
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
  const presentation = { opening: visit.turns[0]!.content, priorHistory: visit.priorHistory, vitals: visit.triageVitals, template: visit.template.map(field => field.id), diagnoses: pack.catalog.diagnoses.map(item => ({ codeSystem: item.codeSystem, code: item.code, name: item.display.en })), services: studies.services, drugs: (prescribing?.catalog ?? []).map(item => ({ codeSystem: item.codeSystem, code: item.code, name: item.display.en, dose: item.inpatientDoseBasis.amount, routeCode: item.routeCodes.default })) };
  const availableTools = new Set(['ask_patient', 'diagnose', 'sign_record', 'complete', ...(studies.services.length ? ['investigate', 'read_report', 'acknowledge_report'] : []), ...(has('prescription.sign') ? ['prescribe', 'no_medication'] : [])]);
  const nativeReads = allowed.filter(entry => entry.method === 'GET' && entry.assistantRead === 'encounter').map(entry => clinicianTool(entry.name.replaceAll(/[.-]/g, '_'), `Read ${entry.name} for the evaluation encounter.`, z.strictObject({}), () => call(entry.name, encounterId)));
  async function doctorAction(action: EvaluationAction, delivered: ReadonlySet<string>) {
    const record: Trace = { role: role!.id, operation: action.name, input: action.args, targetId: encounterId, elapsedMs: Date.now() - started };
    trace.push(record);
    try { record.output = await perform(action, delivered); return record.output; }
    catch (error) { record.error = error instanceof CoreError ? error.code : 'INVALID_INPUT'; throw error; }
  }
  const doctor = await runEvaluationDoctor(store, at, sessionId, clinician, presentation, input.maxTurns, doctorAction, signal, availableTools, [...nativeReads, ...executor.tools ?? []], (operation, fields, error) => {
    trace.push({ role: role.id, operation, input: { fields }, targetId: encounterId, error, elapsedMs: Date.now() - started });
  });
  const final = await encounter();
  const completed = final.status === 'completed';
  const debrief = completed ? await store.read(reader => readCompletedDebrief(reader, resolveActor(reader, credential, new Date().toISOString()), encounterId)) : undefined;
  const truth = debrief?.caseTruth;
  const reported = await studies.signed();
  const medications = prescribing ? await pharmacy() : undefined;
  const patientCalls = await store.read(reader => reader.list(at, 'agent_model_calls', { session_id: encounterId }));
  const primary = final.diagnosisRevisions.at(-1)?.diagnoses.find(item => item.primary);
  if (truth) for (const action of trace) {
    if (action.operation === 'diagnose' || action.operation === 'prescribe') {
      const code = z.object({ code: z.string(), codeSystem: z.string() }).safeParse(action.input).data;
      const expected = action.operation === 'diagnose' ? [truth.primaryDiagnosis, ...truth.secondaryDiagnoses] : truth.expectedMedications ?? [];
      action.hit = !action.error && Boolean(code && expected.some(item => codingKey(item) === codingKey(code)));
    } else if (action.operation === 'investigate') {
      const serviceId = z.object({ serviceId: z.uuidv7() }).safeParse(action.input).data?.serviceId;
      const service = studies.services.find(item => item.id === serviceId);
      action.hit = !action.error && Boolean(service && truth.results.some(item => codingKey(item.service) === codingKey(service)));
    }
  }
  return await saveEvaluationResult(store, at, { runId, ...at, arm: input.arm, packId: pack.manifest.packId, packVersion: pack.manifest.version, caseId: input.caseId, encounterId, status: completed ? 'completed' : 'incomplete', clinicianModel: clinician.model, patientModel: patientConfig.model,
    durationMs: Date.now() - started, turns: doctor.turns, patientTurns: final.turns.filter(turn => turn.speaker === 'patient' && turn.ordinal > 1).length, maxTurns: input.maxTurns, error: doctor.error ?? patientFailure,
    tokens: { clinician: { input: doctor.inputTokens, output: doctor.outputTokens }, patient: { input: patientCalls.reduce((sum, call) => sum + call.input_tokens, 0), output: patientCalls.reduce((sum, call) => sum + call.output_tokens, 0) } },
    redline: trace.some(action => action.error === 'CLINICAL_QUALITY_RED_LINE' || (['diagnosis.draft', 'diagnosis.confirm', 'prescription.sign'].includes(action.operation) && /^(?:MEDICATION_|PRESCRIPTION_|DIAGNOSIS_NOT_IN_CATALOG|DUPLICATE_DIAGNOSIS|ONE_PRIMARY_DIAGNOSIS_REQUIRED)/.test(action.error ?? ''))), trace,
    hits: truth ? { diagnosis: Boolean(primary && codingKey(primary) === codingKey(truth.primaryDiagnosis)), investigations: hits(truth.results.map(result => result.service), reported), medications: hits(truth.expectedMedications ?? [], medications?.prescriptions.filter(item => item.status !== 'withdrawn').flatMap(item => item.lines) ?? []) } : null });
  } finally { await executor.close?.(); }
}
