import { agentTools, createAgent, registerTools, type AgentAction } from '@ui-sdk/react/agent';
import { elementOf } from '@ui-sdk/react/observe';

type RequestApproval = (confirmation: string, context: { signal: AbortSignal }) => boolean | Promise<boolean>;

type Options = { requestApproval?: RequestApproval; within?: () => Element | null; beforeAction?: (action: AgentAction, element: HTMLElement) => boolean };
export function createClinMeshUiAgent({ requestApproval, within, beforeAction }: Options = {}) {
  const visible = (ref: string) => !within || Boolean(within()?.contains(elementOf(ref)));
  const agent = createAgent({ allow: async (step, context) => {
    if (!visible(step.ref) || (beforeAction && !beforeAction(step, elementOf(step.ref)))) return false;
    if (step.confirm && !(await requestApproval?.(step.confirm, context))) return false;
    return !context.signal.aborted && visible(step.ref);
  } });
  const { snapshot, query } = agent;
  const surface = Object.assign(agent, { snapshot: () => snapshot().filter(item => visible(item.ref)), query: async (input: Parameters<typeof agent.query>[0]) => {
    const result = await query(input);
    return Array.isArray(result) ? result.filter(item => visible(item.ref)) : result;
  } });
  return { ...surface, tools: agentTools, elementOf, registerWebMCP: () => registerTools(surface, { allow: () => true }) };
}

let unregister: (() => void) | undefined;
const surfaces: ReturnType<typeof createClinMeshUiAgent>[] = [];
export function mountClinMeshWebMCP(agent: ReturnType<typeof createClinMeshUiAgent>) {
  const refresh = () => { unregister?.(); unregister = surfaces.at(-1)?.registerWebMCP(); };
  surfaces.push(agent); refresh();
  return () => { const index = surfaces.indexOf(agent); if (index >= 0) surfaces.splice(index, 1); refresh(); };
}
