import type { Model, StreamFunction } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { z } from 'zod';
import { uiStep, type AssistantFrame } from '../../agent-protocol';
import { CoreError } from '../../platform';
import type { AgentProvider } from './configuration';
import { upstream } from './model-call';

export const clinicianModel: Model<'clinician'> = { provider: 'clinmesh', api: 'clinician', id: 'clinician', name: 'Clinician Assistant', baseUrl: '', input: ['text'], reasoning: false, maxTokens: 4096, contextWindow: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
export const mockClinician: FauxResponseFactory = transcript => {
  const lastInput = transcript.messages.findLastIndex(message => message.role === 'user');
  const request = transcript.messages[lastInput];
  const instruction = request?.role === 'user' ? typeof request.content === 'string' ? request.content : request.content.find(block => block.type === 'text')?.text ?? '' : '';
  const results = transcript.messages.slice(lastInput + 1).filter(item => item.role === 'toolResult');
  const candidates = /diagnos|诊断|"source":"ambient"/i.test(instruction);
  if (!results.length) return fauxAssistantMessage([fauxToolCall('read_encounter', {}), fauxToolCall('ui_snapshot', {}), ...(candidates ? [fauxToolCall('catalog_diagnoses', { text: 'pneumonia', from: 0 })] : [])], { stopReason: 'toolUse' });
  if (!results.some(result => result.toolName === 'ui_act')) {
    const resultOf = (name: string) => { const raw = results.find(result => result.toolName === name && !result.isError)?.content.find(block => block.type === 'text')?.text; return raw ? JSON.parse(raw) : undefined; };
    const visible = resultOf('read_encounter');
    const controls = resultOf('ui_snapshot');
    const chinese = Array.isArray(controls) && controls.some(item => item.label === '临床页签');
    const tab = (value: string) => ({ ref: chinese ? '临床页签' : 'Clinical views', action: 'setValue', args: [value] });
    const field = visible?.template?.[0]?.title?.[chinese ? 'zh' : 'en'];
    const text = visible?.turns?.at(-1)?.content;
    const steps: z.infer<typeof uiStep>[] = [];
    if (/sign.*record|签署病历/i.test(instruction)) steps.push(tab('record'), { ref: chinese ? '签署病历' : 'Sign record', action: 'press' });
    else {
      if (field && text && /draft|note|ambient|草稿|病历/i.test(instruction)) steps.push(tab('record'), { ref: field, action: 'setValue', args: [text] });
      const diagnosis = candidates && /cough|咳/i.test(visible?.turns?.[0]?.content ?? '') && resultOf('catalog_diagnoses')?.[0];
      if (diagnosis) steps.push(tab('diagnosis'), { ref: chinese ? '诊断目录' : 'Diagnosis catalog', action: 'setValue', args: [JSON.stringify([diagnosis.codeSystem, diagnosis.code])] }, { ref: chinese ? '添加诊断' : 'Add diagnosis', action: 'press' });
    }
    if (steps.length) return fauxAssistantMessage(fauxToolCall('ui_act', { steps }), { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage('**Review the draft** against the consultation and signed reports.');
};

export function clinicianModels(config: AgentProvider, mock: FauxResponseFactory, signal: AbortSignal, emit: (frame: AssistantFrame) => void, authorize: () => Promise<void>) {
  const models = createModels();
  let failure: CoreError | undefined;
  const stream: StreamFunction = (_, transcript, options) => {
    const safe = createAssistantMessageEventStream();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 60000);
    async function generate() {
      await authorize();
      const request = upstream(config, mock);
      const signals = [deadline.signal, signal, ...(options?.signal ? [options.signal] : [])];
      let status = 0;
      const events = request.models.streamSimple(request.model, transcript, { signal: AbortSignal.any(signals), apiKey: config.apiKey || undefined, maxRetries: 0, maxTokens: 4096,
        sessionId: options?.sessionId, reasoning: config.effort === 'off' ? undefined : config.effort, disableContinuation: true,
        fetch: async (resource, init) => { const response = await fetch(resource, { ...init, redirect: 'error' }); status = response.status; return response; } });
      safe.push({ type: 'start', partial: { ...fauxAssistantMessage(''), stopReason: 'pending' } });
      let pending = '';
      let kind: 'assistant' | 'thinking' = 'assistant';
      const send = (all: boolean) => {
        const keep = all ? 0 : Math.max(0, config.apiKey.length - 1);
        if (config.apiKey && pending.includes(config.apiKey)) throw new CoreError(502, 'LLM_PROVIDER_FAILED');
        const length = pending.length - keep;
        if (length > 0) { emit({ type: 'delta', kind, text: pending.slice(0, length) }); pending = pending.slice(length); }
      };
      for await (const event of events) if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        const next = event.type === 'text_delta' ? 'assistant' : 'thinking';
        if (kind !== next) send(true);
        kind = next; pending += event.delta; send(false);
      }
      const message = await events.result();
      if (signal.aborted || options?.signal?.aborted) throw new CoreError(409, 'ASSISTANT_STOPPED');
      if (deadline.signal.aborted || status === 408 || status === 504) throw new CoreError(504, 'LLM_PROVIDER_TIMEOUT');
      if (status === 401 || status === 403) throw new CoreError(422, 'LLM_PROVIDER_AUTH_FAILED');
      if (status === 429) throw new CoreError(429, 'LLM_PROVIDER_RATE_LIMITED');
      if (!['stop', 'length', 'toolUse'].includes(message.stopReason) || (config.apiKey && JSON.stringify(message).includes(config.apiKey))) throw new CoreError(502, 'LLM_PROVIDER_FAILED');
      if (!message.content.some(block => block.type === 'toolCall' || (block.type === 'text' && block.text.trim()))) throw new CoreError(502, 'LLM_PROVIDER_EMPTY_REPLY');
      send(true);
      safe.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message: { ...message, api: clinicianModel.api, provider: clinicianModel.provider, model: clinicianModel.id } });
    }
    void generate().catch(error => {
      failure = error instanceof CoreError ? error : new CoreError(502, 'LLM_PROVIDER_FAILED');
      safe.push({ type: 'error', reason: 'error', error: { ...fauxAssistantMessage(''), stopReason: 'error', errorMessage: failure.code } });
    }).finally(() => { clearTimeout(timer); safe.end(); });
    return safe;
  };
  models.setProvider(createProvider({ id: clinicianModel.provider, models: [clinicianModel], auth: { apiKey: { name: 'Clinician runtime', resolve: async () => ({ auth: {} }) } }, api: { stream, streamSimple: stream } }));
  return { models, failure: () => failure };
}
