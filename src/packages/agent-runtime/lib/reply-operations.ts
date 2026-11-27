import { z } from 'zod';
import { receiptSchema, replyState } from '../../agent-protocol';
import { editEncounter, requireEncounter, submitQuestion, turnInput } from '../../patient-visit';
import { CoreError, sha256, type OperationCatalog } from '../../platform';
import type { EntityRow, StoreReader, StoreScope, StoreTx } from '../../store';
import { resolveAgentProvider, type AgentEnvironment, type AgentProvider } from './configuration';

const base = '/api/his/encounters/:id/consultation';
export const assess = { capabilities: ['assess'] };
export type ReplyRun = EntityRow<'patient_reply_runs'>;
export function publicRun(run: ReplyRun) { return { questionId: run.id, sessionId: run.session_id, attempt: run.attempt, status: run.status, code: run.error_code }; }
export const providerBinding = async (config: AgentProvider) => ({ provider: config.provider, model: config.model, effort: config.effort, endpoint_hash: await sha256(config.baseUrl) });
export function setPending(tx: StoreTx, at: StoreScope, encounterId: string, pending: boolean) {
  const consultation = tx.list(at, 'consultations', { encounter_id: encounterId })[0]!;
  if (consultation.reply_pending !== pending) tx.update(at, 'consultations', consultation.id, consultation.version, { reply_pending: pending });
}
function latestQuestion(reader: StoreReader, at: StoreScope, encounterId: string) {
  const consultation = reader.list(at, 'consultations', { encounter_id: encounterId })[0]!;
  const lastQuestion = reader.list(at, 'consultation_turns', { consultation_id: consultation.id, speaker: 'clinician' }).sort((first, second) => second.ordinal - first.ordinal)[0];
  return { lastQuestion, pending: consultation.reply_pending, run: lastQuestion && reader.get(at, 'patient_reply_runs', lastQuestion.id) };
}

function patientSession(tx: StoreTx, at: StoreScope, encounterId: string) {
  const existing = tx.list(at, 'pi_sessions', { encounter_id: encounterId, agent: 'patient' })[0];
  if (existing) return existing.id;
  tx.insert(at, 'pi_sessions', { id: encounterId, encounter_id: encounterId, agent: 'patient' });
  return encounterId;
}
const priorReceipt = receiptSchema.pick({ version: true, turnId: true });
function protectEnvelope(input: object, config: AgentProvider) {
  if (config.apiKey && JSON.stringify(input).includes(config.apiKey)) throw new CoreError(400, 'LLM_SECRET_IN_INPUT');
}

export function registerPatientOperations(catalog: OperationCatalog, env: AgentEnvironment) {
  catalog.command({ name: 'consultation.question', method: 'POST', path: `${base}/turns`, access: assess }, turnInput.shape, z.union([receiptSchema, priorReceipt]), async (context, input, _, headers) => {
    const { tx, at, targetId } = context;
    const encounter = requireEncounter(tx, at, targetId);
    if (encounter.active_practitioner_role === context.actor.role.id && encounter.status === 'active' && tx.list(at, 'consultations', { encounter_id: targetId })[0]?.reply_pending) throw new CoreError(409, 'CONSULTATION_REPLY_IN_FLIGHT');
    const result = submitQuestion(context, { content: input.content, channel: input.channel });
    const config = resolveAgentProvider(headers ?? new Headers(), env);
    protectEnvelope(input, config);
    const sessionId = patientSession(tx, at, targetId);
    tx.insert(at, 'patient_reply_runs', { id: result.turnId, session_id: sessionId, attempt: 1, status: 'running', error_code: null, version: 1, ...await providerBinding(config) });
    return { ...result, sessionId, attempt: 1 };
  });
  catalog.query({ name: 'consultation.reply-state', path: `${base}/reply`, access: {} }, replyState.nullable(), ({ reader, actor, targetId }) => {
    requireEncounter(reader, actor.at, targetId);
    const { lastQuestion, pending, run } = latestQuestion(reader, actor.at, targetId);
    if (run) return publicRun(run);
    return pending && lastQuestion ? { sessionId: targetId, questionId: lastQuestion.id, attempt: 0, status: 'stopped', code: 'PATIENT_REPLY_NEEDS_RESUME' } : null;
  });
  for (const action of ['stop', 'retry'] as const) {
    catalog.command({ name: `consultation.${action}`, method: 'POST', path: `${base}/${action}`, access: assess }, { questionId: z.uuidv7(), attempt: z.int().nonnegative() }, receiptSchema, async (context, input, _, headers) => {
      const { tx, at, targetId } = context;
      const version = editEncounter(context);
      const { run, lastQuestion, pending } = latestQuestion(tx, at, targetId);
      const retry = action === 'retry';
      if (!run && pending && lastQuestion?.id === input.questionId && input.attempt === 0) {
        const sessionId = patientSession(tx, at, targetId);
        const config = retry ? resolveAgentProvider(headers ?? new Headers(), env) : null;
        if (config) protectEnvelope(input, config);
        const binding = config ? await providerBinding(config) : { provider: 'unconfigured', model: 'unconfigured', endpoint_hash: await sha256(''), effort: 'off' };
        tx.insert(at, 'patient_reply_runs', { id: input.questionId, session_id: sessionId, attempt: 1, status: retry ? 'running' : 'stopped', error_code: null, version: 1, ...binding });
        setPending(tx, at, targetId, retry);
        return { version, sessionId, turnId: input.questionId, attempt: 1 };
      }
      if (!run || run.id !== input.questionId || run.attempt !== input.attempt) throw new CoreError(409, 'QUESTION_CHANGED');
      if (run.status === 'done' || (action === 'stop') !== (run.status === 'running')) throw new CoreError(409, 'REPLY_STATE_CHANGED');
      const attempt = run.attempt + Number(retry);
      const config = retry ? resolveAgentProvider(headers ?? new Headers(), env) : undefined;
      if (config) protectEnvelope(input, config);
      const binding = config ? await providerBinding(config) : {};
      tx.update(at, 'patient_reply_runs', run.id, run.version, { status: retry ? 'running' : 'stopped', attempt, error_code: null, ...binding });
      setPending(tx, at, targetId, retry);
      return { version, sessionId: run.session_id, turnId: run.id, attempt };
    });
  }
}
