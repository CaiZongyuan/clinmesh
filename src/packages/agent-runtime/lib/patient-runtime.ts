import { z } from 'zod';
import { receiptSchema } from '../../agent-protocol';
import { appendPatientReply, requireEncounter } from '../../patient-visit';
import { authorize, CoreError, resolveActor, type Credential } from '../../platform';
import type { StorePort, StoreScope } from '../../store';
import { resolveAgentProvider, type AgentEnvironment, type AgentProvider } from './configuration';
import { durablePatientAnswer } from './durable-patient';
import { callModel } from './model-call';
import { assess, providerBinding, publicRun, setPending, type ReplyRun } from './reply-operations';

type Background = (task: Promise<void>) => void;
type Job = { id: string; attempt: number; controller: AbortController; finished: Promise<void> };
export class PatientRuntime {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly store: StorePort, private readonly environment: AgentEnvironment, private readonly background: Background = () => {}) {}

  private locate(credential: Credential, sessionId: string, questionId?: string) {
    return this.store.read(reader => {
      const actor = resolveActor(reader, credential, new Date().toISOString());
      authorize(actor, { name: 'consultation.question', access: assess });
      const session = reader.get(actor.at, 'pi_sessions', z.uuidv7().parse(sessionId));
      if (session?.agent !== 'patient' || !session.encounter_id) throw new CoreError(404, 'PATIENT_SESSION_NOT_FOUND');
      const encounterId = session.encounter_id;
      if (requireEncounter(reader, actor.at, encounterId).active_practitioner_role !== actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
      const run = questionId ? reader.get(actor.at, 'patient_reply_runs', z.uuidv7().parse(questionId)) : reader.list(actor.at, 'patient_reply_runs', { session_id: session.id }).at(-1);
      if (!run || run.session_id !== sessionId) throw new CoreError(404, 'PATIENT_REPLY_NOT_FOUND');
      return { at: actor.at, encounterId, run };
    });
  }
  private async drive(at: StoreScope, encounterId: string, run: ReplyRun, config: AgentProvider, signal: AbortSignal) {
    try {
      const current = await this.store.read(reader => reader.get(at, 'patient_reply_runs', run.id));
      if (current?.status !== 'running' || current.attempt !== run.attempt) return;
      const answer = await durablePatientAnswer(this.store, at, encounterId, run, config, signal);
      await this.store.withTransaction(async tx => {
        const live = tx.get(at, 'patient_reply_runs', run.id)!;
        if (live.status !== 'running' || live.attempt !== run.attempt) return;
        await appendPatientReply(tx, at, encounterId, run.id, { content: answer, channel: 'text' });
        tx.update(at, 'patient_reply_runs', run.id, live.version, { status: 'done' });
      });
    } catch (error) {
      await this.store.withTransaction(tx => {
        const live = tx.get(at, 'patient_reply_runs', run.id)!;
        if (live.status !== 'running' || live.attempt !== run.attempt) return;
        tx.update(at, 'patient_reply_runs', run.id, live.version, { status: 'failed', error_code: error instanceof CoreError ? error.code : 'LLM_PROVIDER_FAILED' });
        setPending(tx, at, encounterId, false);
      });
    }
  }
  private async join(at: StoreScope, encounterId: string, run: ReplyRun, headers: Headers) {
    if (run.status !== 'running') return;
    const matches = (job?: Job) => job?.id === run.id && job.attempt === run.attempt;
    if (matches(this.jobs.get(run.session_id))) return;
    const config = resolveAgentProvider(headers, this.environment);
    const bound = await providerBinding(config);
    if (run.provider !== bound.provider || run.model !== bound.model || run.endpoint_hash !== bound.endpoint_hash || run.effort !== bound.effort) throw new CoreError(409, 'LLM_REJOIN_CONFIGURATION_REQUIRED');
    const previous = this.jobs.get(run.session_id);
    if (matches(previous)) return;
    const controller = new AbortController();
    const finished = (previous?.finished ?? Promise.resolve()).then(() => this.drive(at, encounterId, run, config, controller.signal)).finally(() => {
      if (this.jobs.get(run.session_id)?.controller === controller) this.jobs.delete(run.session_id);
    });
    this.jobs.set(run.session_id, { id: run.id, attempt: run.attempt, controller, finished });
    this.background(finished.catch(() => {}));
  }
  async admitted(operation: string, result: unknown, credential: Credential, headers: Headers) {
    const parsed = receiptSchema.safeParse(result);
    if (!parsed.success) return;
    const { sessionId, turnId, attempt } = parsed.data;
    if (operation === 'consultation.stop') {
      const job = this.jobs.get(sessionId);
      if (job?.id === turnId && job.attempt === attempt) job.controller.abort();
      return;
    }
    const { at, encounterId, run } = await this.locate(credential, sessionId, turnId);
    if (run.attempt === attempt) await this.join(at, encounterId, run, headers);
  }
  async testProvider(credential: Credential, headers: Headers, input: unknown) {
    const { role } = z.strictObject({ role: z.enum(['patient', 'clinician']).default('patient') }).parse(input);
    const at = await this.store.read(reader => {
      const actor = resolveActor(reader, credential, new Date().toISOString());
      authorize(actor, { name: 'agents.provider-test', access: { visitorOnly: true } });
      return actor.at;
    });
    const config = resolveAgentProvider(headers, this.environment, role);
    const answer = await callModel({ store: this.store, at }, config, { context: { messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }] }, accept: () => true, mockAnswer: 'OK' });
    if (!answer) throw new CoreError(502, 'LLM_PROVIDER_FAILED');
    return { ok: true, provider: config.provider, model: config.model };
  }
  async events(credential: Credential, sessionId: string, request: Request) {
    const id = new URL(request.url).searchParams.get('questionId') ?? undefined;
    const { at, encounterId, run } = await this.locate(credential, sessionId, id);
    await this.join(at, encounterId, run, request.headers);
    const cursor = request.headers.get('last-event-id')?.split('/');
    const seen = cursor?.[0] === run.id && cursor[1] === String(run.attempt) ? z.coerce.number().int().nonnegative().max(9000).parse(cursor[2]) : -1;
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; }, start: async controller => {
      const emit = (ordinal: number, event: object) => {
        if (ordinal > seen && !cancelled) controller.enqueue(encoder.encode(`id: ${run.id}/${run.attempt}/${ordinal}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      try {
        if (run.status === 'running') emit(0, publicRun(run));
        const job = this.jobs.get(sessionId);
        if (run.status === 'running' && job) await job.finished;
        if (cancelled) return;
        const current = await this.locate(credential, sessionId, run.id);
        if (current.run.attempt !== run.attempt) { emit(1, { ...publicRun(run), status: 'stopped' }); return; }
        const state = publicRun(current.run);
        const answer = state.status === 'done' ? await this.store.read(reader => {
          const receipt = reader.findCommandReceipt(at, `patient-reply:${run.id}`)!;
          return reader.get(at, 'consultation_turns', z.uuidv7().parse(receipt.result))!.content;
        }) : '';
        const chars = Array.from(answer);
        const chunkSize = Math.max(24, Math.ceil(chars.length / 12));
        let ordinal = 1;
        for (let end = chunkSize; end < chars.length && !cancelled; end += chunkSize) {
          emit(ordinal++, { ...state, status: 'text', content: chars.slice(0, end).join('') });
          if (ordinal > seen) await new Promise(resolve => setTimeout(resolve, 16));
        }
        if (answer) emit(ordinal++, { ...state, status: 'text', content: answer });
        emit(ordinal, state);
      } catch { controller.error(new Error('PATIENT_STREAM_INTERRUPTED')); }
      finally { if (!cancelled) { try { controller.close(); } catch {} } }
    } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  }
}
