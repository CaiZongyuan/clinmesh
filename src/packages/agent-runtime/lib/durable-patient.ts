import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Model, StreamFunction } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { AssistantEntry, createRegistry } from '@earendil-works/pi-durable';
import type { ReplyProgress } from '../../agent-protocol';
import { CoreError } from '../../platform';
import type { EntityRow, StorePort, StoreScope } from '../../store';
import type { AgentProvider } from './configuration';
import { patientContext, patientMessage, patientOutputGuard } from './patient-context';
import { callModel } from './model-call';
import { openDurableAgentSession } from './session';

const context = BACKGROUND_CONTEXT;
const model: Model<'patient'> = { provider: 'clinmesh', api: 'patient', id: 'patient', name: 'Patient Agent', baseUrl: '', input: ['text'], reasoning: false, maxTokens: 512, contextWindow: 131072, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const agent = { model: { provider: model.provider, modelId: model.id }, tools: [], maxTurns: 1 };

export async function stopDurablePatient(store: StorePort, at: StoreScope, run: EntityRow<'patient_reply_runs'>) {
  const harness = await openDurableAgentSession(store, at, run.session_id, 'patient', { models: createModels(), registry: createRegistry() });
  try {
    const pending = await harness.inspect(context);
    if (pending.submissions.some(item => item.requestId === `${run.id}/${run.attempt}`)) await (await harness.root(context)).abort(context);
  } finally { await harness.close(context); }
  await store.withTransaction(tx => {
    for (const call of tx.list(at, 'agent_model_calls', { session_id: run.session_id, question_id: run.id, status: 'running' })) {
      tx.update(at, 'agent_model_calls', call.id, call.version, { status: 'PATIENT_REPLY_STOPPED', duration_ms: Math.max(0, Date.now() - Date.parse(call.recorded_at)) });
    }
  });
}

export async function durablePatientAnswer(store: StorePort, at: StoreScope, encounterId: string, run: EntityRow<'patient_reply_runs'>, provider: AgentProvider, signal: AbortSignal, progress: (event: ReplyProgress) => void) {
  const { visible, accepts } = await store.read(reader => ({ visible: patientContext(reader, at, encounterId, run.id), accepts: patientOutputGuard(reader, at, encounterId) }));
  const scope = { store, at, sessionId: run.session_id, questionId: run.id };
  let failure: CoreError | undefined;
  const protectedStream: StreamFunction = (_model, _transcript, options) => {
    const stream = createAssistantMessageEventStream();
    const requestSignal = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
    async function generate() {
      const input = { context: visible.context, mockAnswer: visible.mockAnswer, signal: requestSignal, accept: accepts, sessionId: options?.sessionId, progress };
      let approved = await callModel(scope, provider, input);
      if (!approved) {
        const correction = { role: 'user' as const, content: 'Answer again in everyday language. Only describe your own experience.', timestamp: Date.now() };
        approved = await callModel(scope, provider, { ...input, pass: 2, context: { ...input.context, messages: [...input.context.messages, correction] } }) ?? visible.safeAnswer;
      }
      const message = patientMessage(approved);
      stream.push({ type: 'start', partial: patientMessage('') });
      stream.push({ type: 'done', reason: 'stop', message });
    }
    void generate().catch(error => {
      failure = error instanceof CoreError ? error : new CoreError(502, 'LLM_PROVIDER_FAILED');
      const message = { ...patientMessage(''), stopReason: 'error' as const, errorMessage: failure.code };
      stream.push({ type: 'error', reason: 'error', error: message });
    }).finally(() => stream.end());
    return stream;
  };
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'Patient runtime', resolve: async () => ({ auth: {} }) } }, api: { stream: protectedStream, streamSimple: protectedStream } }));
  await store.withTransaction(tx => {
    for (const call of tx.list(at, 'agent_model_calls', { session_id: run.session_id, status: 'running' })) tx.update(at, 'agent_model_calls', call.id, call.version, { status: 'interrupted' });
  });
  const harness = await openDurableAgentSession(store, at, run.session_id, 'patient', { models, registry: createRegistry(), settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } } });
  try {
    const root = await harness.root(context, { agent });
    const requestId = `${run.id}/${run.attempt}`;
    const pending = await harness.inspect(context);
    if (pending.submissions.some(submission => submission.requestId !== requestId)) await root.abort(context);
    const submission = await root.submit({ type: 'input', requestId, content: visible.question.content }, context);
    const settled = await submission.wait(context);
    if (settled.type !== 'input' || settled.status !== 'done') throw failure ?? new CoreError(502, 'LLM_PROVIDER_FAILED');
    const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
    const message = answer?.model?.find(item => item.role === 'assistant');
    const text = message?.content.filter(block => block.type === 'text').map(block => block.text).join('');
    if (!text || !accepts(text)) throw new CoreError(502, 'LLM_PROVIDER_FAILED');
    return text;
  } finally { await harness.close(context); }
}
