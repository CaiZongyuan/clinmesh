import { AlertDialog, AlertDialogBackdrop, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, createConfirm } from '@ui-sdk/react/alert-dialog';

export function createApprovalPrompt() {
  const ask = createConfirm<string>();
  async function requestApproval(message: string, { signal }: { signal: AbortSignal }) {
    if (signal.aborted) return false;
    const dismiss = () => { ask.controller.close(); };
    signal.addEventListener('abort', dismiss, { once: true });
    try { return await ask(message) && !signal.aborted; }
    finally { signal.removeEventListener('abort', dismiss); }
  }
  return { controller: ask.controller, requestApproval };
}

export function UiAgentApprovalDialog({ prompt }: { prompt: ReturnType<typeof createApprovalPrompt> }) {
  return <div data-agent-hidden>
    <AlertDialog controller={prompt.controller}>
      <AlertDialogBackdrop />
      <AlertDialogContent<string> data-agent-hidden>{state => <>
        <AlertDialogTitle>Approve agent action</AlertDialogTitle>
        <AlertDialogDescription>{state.payload}</AlertDialogDescription>
        <div className="cm-actions"><AlertDialogClose>Deny request</AlertDialogClose><AlertDialogClose value="confirm" data-variant="solid">Allow once</AlertDialogClose></div>
      </>}</AlertDialogContent>
    </AlertDialog>
  </div>;
}
