import { z } from 'zod';
import { create } from 'zustand';
import { permitsProviderKey, providerName, reasoningEffort, type AgentRole } from '../packages/agent-protocol';

const role = z.object({ model: z.string().default(''), effort: reasoningEffort.or(z.literal('')).default('') });
const schema = z.object({ provider: providerName.or(z.literal('')).default(''), baseUrl: z.string().default(''), apiKey: z.string().default(''), model: z.string().default(''), mock: z.boolean().default(false),
  patient: role.prefault({}), clinician: role.prefault({}) });
const key = 'clinmesh.providers.v1';
function read() {
  try { return schema.parse(JSON.parse(localStorage.getItem(key) ?? '{}')); } catch { return schema.parse({}); }
}
type Values = z.infer<typeof schema>;
export const useModelSettings = create<{ values: Values; open: boolean }>(() => ({ values: read(), open: false }));
export function saveModelSettings(change: Partial<Values>) {
  const values = { ...useModelSettings.getState().values, ...change };
  localStorage.setItem(key, JSON.stringify(values));
  useModelSettings.setState({ values });
}
export function modelHeaders(agent: AgentRole): Record<string, string> {
  const values = read();
  if (values.mock) return { 'X-ClinMesh-LLM-Mock': '1' };
  if (values.apiKey && !permitsProviderKey(new URL(window.location.href))) throw Error('LLM_HTTPS_REQUIRED');
  const fields = { Provider: values.provider, 'Base-Url': values.baseUrl, 'Api-Key': values.apiKey, Model: values[agent].model || values.model, Reasoning: values[agent].effort };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value).map(([name, value]) => [`X-ClinMesh-LLM-${name}`, value]));
}
