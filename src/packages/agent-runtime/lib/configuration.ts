import { z } from 'zod';
import { providerName, reasoningEffort, type AgentRole } from '../../agent-protocol';
import { CoreError } from '../../platform';

const modelId = z.string().min(1).max(160).regex(/^[\w./:-]+$/);
const defaults = {
  openai: ['https://api.openai.com/v1', 'gpt-4o-mini'], anthropic: ['https://api.anthropic.com', 'claude-sonnet-4-6'], gemini: ['https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash'],
} as const;
export type AgentEnvironment = Partial<Record<`CLINMESH_LLM_${'PROVIDER' | 'BASE_URL' | 'API_KEY' | 'MODEL' | 'ALLOWED_BASE_URLS' | 'PATIENT_MODEL' | 'CLINICIAN_MODEL' | 'PATIENT_EFFORT' | 'CLINICIAN_EFFORT'}`, string>>;
const normalizedUrl = (value: string) => value.replace(/\/+$/, '');
export function resolveAgentProvider(headers: Headers, environment: AgentEnvironment, role: AgentRole = 'patient') {
  const header = (name: string) => headers.get(`X-ClinMesh-LLM-${name}`);
  const effort = reasoningEffort.safeParse(header('Reasoning') || environment[role === 'patient' ? 'CLINMESH_LLM_PATIENT_EFFORT' : 'CLINMESH_LLM_CLINICIAN_EFFORT'] || 'off');
  if (!effort.success) throw new CoreError(400, 'LLM_CONFIGURATION_INVALID');
  if (header('Mock') === '1') return { provider: 'mock' as const, model: 'scripted-patient', baseUrl: '', apiKey: '', effort: effort.data };
  const parsed = providerName.safeParse(header('Provider') || environment.CLINMESH_LLM_PROVIDER || 'openai');
  if (!parsed.success) throw new CoreError(400, 'LLM_CONFIGURATION_INVALID');
  const provider = parsed.data;
  const browserEndpoint = !!(header('Base-Url') || header('Provider'));
  const baseUrl = normalizedUrl(header('Base-Url') || (!browserEndpoint && environment.CLINMESH_LLM_BASE_URL) || defaults[provider][0]);
  const endpoint = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
  const allowed = [defaults[provider][0], environment.CLINMESH_LLM_BASE_URL, ...(environment.CLINMESH_LLM_ALLOWED_BASE_URLS ?? '').split(',')].filter((value): value is string => !!value).map(value => normalizedUrl(value.trim()));
  if (!endpoint || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || !allowed.includes(baseUrl) ||
      !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new CoreError(400, 'LLM_ENDPOINT_NOT_ALLOWED');
  const apiKey = header('Api-Key') || (!browserEndpoint && environment.CLINMESH_LLM_API_KEY) || '';
  if (!apiKey) throw new CoreError(422, 'LLM_PROVIDER_UNCONFIGURED');
  const model = modelId.safeParse(header('Model') || (!browserEndpoint && (environment[role === 'patient' ? 'CLINMESH_LLM_PATIENT_MODEL' : 'CLINMESH_LLM_CLINICIAN_MODEL'] || environment.CLINMESH_LLM_MODEL)) || defaults[provider][1]);
  if (!model.success || apiKey.length > 8192 || model.data.includes(apiKey) || baseUrl.includes(apiKey)) throw new CoreError(400, 'LLM_CONFIGURATION_INVALID');
  return { provider, model: model.data, baseUrl, apiKey, effort: effort.data };
}
export type AgentProvider = ReturnType<typeof resolveAgentProvider>;
