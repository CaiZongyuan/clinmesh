import { maxUiCommands, uiCommandKey, type AssistantBinding } from '../packages/agent-protocol';

type Capture = { binding: AssistantBinding; token: string; approved: boolean; receipts: Promise<boolean>[] };
let current: Capture | undefined;
export function captureAssistantCommands(binding: AssistantBinding, token: string) {
  const capture: Capture = { binding, token, approved: false, receipts: [] };
  current = capture;
  return {
    async finish() { if (current === capture) current = undefined; return (await Promise.all(capture.receipts)).some(uncertain => uncertain); },
    approve() { capture.approved = true; },
    disarm() { capture.approved = false; },
  };
}
export function sendWorkbenchCommand<Value>(scope: Pick<AssistantBinding, 'workspaceId' | 'roleId' | 'epoch'>, send: (key: string) => Promise<Value>) {
  const capture = current;
  if (!capture?.approved || capture.binding.workspaceId !== scope.workspaceId || capture.binding.roleId !== scope.roleId || capture.binding.epoch !== scope.epoch) return send(crypto.randomUUID());
  if (capture.receipts.length >= maxUiCommands) return Promise.reject(Error('ASSISTANT_COMMAND_LIMIT'));
  const result = send(uiCommandKey(capture.token, capture.receipts.length));
  capture.receipts.push(result.then(() => false, () => true));
  return result;
}
