import { Button } from '@ui-sdk/react/button';
import { useRef, useState, type ComponentProps } from 'react';

export function ConfirmActionButton({ confirmation, ...props }: ComponentProps<typeof Button> & { confirmation: string }) {
  return <Button {...props} data-agent-confirm={confirmation.trim() || 'Confirm this action?'} data-variant="solid" />;
}

interface ConfirmationProps {
  trigger: string;
  confirm: string;
  cancel: string;
  confirmation: string;
  onConfirm: () => void | Promise<void>;
}

export function InlineConfirmBar({ trigger, confirm, cancel, confirmation, onConfirm }: ConfirmationProps) {
  const [phase, setPhase] = useState<'idle' | 'review' | 'submitting'>('idle');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  function close() {
    if (actions.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setPhase('idle');
  }
  async function submit() {
    setPhase('submitting');
    try { await onConfirm(); close(); }
    catch (error) { setPhase('review'); throw error; }
  }
  return <div className="cm-confirm-bar">
    <Button ref={triggerRef} aria-expanded={phase !== 'idle'} onClick={() => { if (phase === 'idle') setPhase('review'); }}>{trigger}</Button>
    {phase !== 'idle' && <div ref={actions} className="cm-actions" role="group" aria-label={confirmation}>
      <span>{confirmation}</span>
      <Button disabled={phase === 'submitting'} onClick={close}>{cancel}</Button>
      <ConfirmActionButton confirmation={confirmation} onClick={submit}>{confirm}</ConfirmActionButton>
    </div>}
  </div>;
}
