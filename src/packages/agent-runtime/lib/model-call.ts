import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { v7 } from 'uuid';
import type { ReplyProgress } from '../../agent-protocol';
import { CoreError } from '../../platform';
import type { StorePort, StoreScope } from '../../store';
import type { AgentProvider } from './configuration';

type CallScope = { store: StorePort; at: StoreScope; sessionId?: string; questionId?: string };
type CallInput = { context: Context; mockAnswer: string; accept(text: string): boolean; signal?: AbortSignal; sessionId?: string; progress?(event: ReplyProgress): void; pass?: 1 | 2 };

export function upstream(config: AgentProvider, mockAnswer: string | FauxResponseFactory) {
  const models = createModels();
  if (config.provider === 'mock') {
    const faux = fauxProvider({ provider: 'mock', models: [{ id: config.model }], tokensPerSecond: Infinity });
    faux.setResponses([typeof mockAnswer === 'string' ? fauxAssistantMessage(mockAnswer) : mockAnswer]);
    models.setProvider(faux.provider);
    return { models, model: faux.getModel() };
  }
  const provider = config.provider === 'openai' ? createProvider({ id: 'openai', models: [], auth: { apiKey: { name: 'BYOK', resolve: async () => ({ auth: {} }) } }, api: openAICompletionsApi() }) : config.provider === 'gemini' ? googleProvider() : anthropicProvider();
  const api = { openai: 'openai-completions', anthropic: 'anthropic-messages', gemini: 'google-generative-ai' }[config.provider];
  const catalog = provider.getModels().find(item => item.id === config.model);
  const model: Model<string> = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048, reasoning: config.effort !== 'off', ...catalog,
    api, provider: provider.id, id: config.model, name: config.model, baseUrl: config.baseUrl, input: ['text'], compat: undefined };
  models.setProvider({ ...provider, getModels: () => [model] });
  return { models, model };
}

function modelError(status: number, timedOut: boolean, signal?: AbortSignal) {
  if (signal?.aborted) return new CoreError(409, 'PATIENT_REPLY_STOPPED');
  if (timedOut || [408, 504].includes(status)) return new CoreError(504, 'LLM_PROVIDER_TIMEOUT');
  if ([401, 403].includes(status)) return new CoreError(422, 'LLM_PROVIDER_AUTH_FAILED');
  if (status === 429) return new CoreError(429, 'LLM_PROVIDER_RATE_LIMITED');
  return new CoreError(502, 'LLM_PROVIDER_FAILED');
}
export async function callModel(scope: CallScope, config: AgentProvider, input: CallInput) {
  const start = Date.now();
  const id = v7();
  await scope.store.withTransaction(tx => tx.insert(scope.at, 'agent_model_calls', { id, session_id: scope.sessionId ?? null, question_id: scope.questionId ?? null, provider: config.provider, model: config.model,
    status: 'running', input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, duration_ms: 0, recorded_at: new Date(start).toISOString(), version: 1 }));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 60_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  let httpStatus = 0;
  let usage: Usage | undefined;
  let outcome = 'failed';
  try {
    const { model, models } = upstream(config, input.mockAnswer);
    const options: SimpleStreamOptions = { signal, apiKey: config.apiKey || undefined, maxRetries: 0, maxTokens: 512, timeoutMs: 60_000, sessionId: input.sessionId,
      reasoning: config.effort === 'off' ? undefined : config.effort, transport: 'sse', disableContinuation: true,
      fetch: async (resource, init) => {
        const response = await fetch(resource, { ...init, redirect: 'error' });
        httpStatus = response.status;
        return response;
      } };
    let answer: AssistantMessage;
    try {
      const stream = models.streamSimple(model, input.context, options);
      let chunks = 0;
      for await (const event of stream) {
        if (event.type !== 'text_delta' && event.type !== 'thinking_delta') continue;
        chunks++;
        if (chunks <= 512 && (chunks & (chunks - 1)) === 0) input.progress?.({ phase: 'receiving', pass: input.pass ?? 1, chunks });
      }
      answer = await stream.result();
      if (answer.stopReason === 'stop' || answer.stopReason === 'length') input.progress?.({ phase: 'checking', pass: input.pass ?? 1, chunks });
    }
    catch { throw modelError(httpStatus, deadline.signal.aborted, input.signal); }
    usage = answer.usage;
    if (signal.aborted || !['stop', 'length'].includes(answer.stopReason)) throw modelError(httpStatus, deadline.signal.aborted, input.signal);
    const text = answer.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
    if (!text) throw new CoreError(502, 'LLM_PROVIDER_EMPTY_REPLY');
    if ((config.apiKey && text.includes(config.apiKey)) || !input.accept(text)) {
      outcome = 'rejected'; return undefined;
    }
    outcome = 'ok'; return text;
  } catch (error) {
    const failure = error instanceof CoreError ? error : modelError(httpStatus, deadline.signal.aborted, input.signal);
    outcome = failure.code;
    throw failure;
  } finally {
    clearTimeout(timer);
    const count = (value?: number) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
    await scope.store.withTransaction(tx => tx.update(scope.at, 'agent_model_calls', id, 1, {
      status: outcome, input_tokens: count(usage?.input), output_tokens: count(usage?.output), cache_read: count(usage?.cacheRead), cache_write: count(usage?.cacheWrite), duration_ms: Math.max(0, Date.now() - start) }));
  }
}
