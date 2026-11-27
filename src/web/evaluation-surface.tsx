import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, ConfirmActionButton, createClinMeshUiAgent, Field, mountClinMeshWebMCP, Textarea } from '../packages/ui-kit';

declare global {
  interface Window {
    evaluationOperations?: { id: string; formal: boolean }[];
    submitEvaluationOperation?: (id: string, input: unknown) => Promise<unknown>;
  }
}

function EvaluationSurface() {
  const input = useRef('{}');
  const [receipt, setReceipt] = useState({ sequence: 0, result: '{}' });
  async function submit(id: string) {
    const result = await window.submitEvaluationOperation!(id, JSON.parse(input.current));
    setReceipt(previous => ({ sequence: previous.sequence + 1, result: JSON.stringify(result) }));
  }
  return <><h1>Isolated Evaluation Run</h1><Field label="Operation input"><Textarea defaultValue="{}" onValueChange={value => { input.current = value; }}/></Field>
    {window.evaluationOperations?.map(({ id, formal }) => formal ? <ConfirmActionButton key={id} confirmation={id} onClick={() => void submit(id)}>{id}</ConfirmActionButton> : <Button key={id} onClick={() => void submit(id)}>{id}</Button>)}
    <output id="receipt" data-sequence={receipt.sequence}>{receipt.result}</output></>;
}

if (window.evaluationOperations && window.submitEvaluationOperation) {
  const agent = createClinMeshUiAgent({ requestApproval: id => Boolean(window.evaluationOperations?.some(operation => operation.formal && operation.id === id)) });
  mountClinMeshWebMCP(agent);
  createRoot(document.getElementById('root')!).render(<EvaluationSurface/>);
}
