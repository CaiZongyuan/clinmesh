import { agentTools, createAgent, registerTools } from '@ui-sdk/react/agent';

type RequestApproval = (confirmation: string, context: { signal: AbortSignal }) => boolean | Promise<boolean>;

export function createClinMeshUiAgent({ requestApproval }: { requestApproval?: RequestApproval } = {}) {
  const agent = createAgent({ allow: (step, context) => step.confirm ? requestApproval?.(step.confirm, context) ?? false : true });
  return { ...agent, tools: agentTools, registerWebMCP: () => registerTools(agent, { allow: () => true }) };
}
