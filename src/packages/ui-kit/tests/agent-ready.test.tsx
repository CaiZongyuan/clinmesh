// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AlertDialog, Button, Checkbox, createClinMeshUiAgent, Dialog, Field, IconButton, Input, InlineConfirmBar, Menu,
  NumberInput, Select, Switch, Tabs, Textarea, ToastProvider, useToast } from '../index';
import { useState } from 'react';

const approve = vi.fn(() => false);
const agent = createClinMeshUiAgent({ requestApproval: approve });

afterEach(() => { cleanup(); approve.mockReset(); });

async function press(ref: string) {
  return agent.act({ steps: [{ ref, action: 'press' }] });
}

function Controls({ onAction }: { onAction: (value: string) => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  return <>
    <Field label="Draft title"><Input value={note} onValueChange={(value, details) => { setNote(value); onAction(details.source); }} /></Field>
    <Field label="Instructions"><Textarea /></Field>
    <Field label="Quantity"><NumberInput min={1} defaultValue={1} /></Field>
    <Field label="Priority"><Select options={[{ value: 'low', label: 'Routine' }, { value: 'high', label: 'Urgent' }]} /></Field>
    <Checkbox label="Include summary" /><Switch label="Show activity" />
    <Tabs label="View mode" items={[{ value: 'list', label: 'List', content: 'List entries' }, { value: 'detail', label: 'Detail', content: 'Detailed entries' }]} />
    <Dialog title="Preview details" triggers={['Open first preview', 'Open second preview']} close="Leave preview">Preview content</Dialog>
    <AlertDialog trigger="Review removal" title="Remove draft?" confirmation="Discard this draft?" confirm="Remove permanently" cancel="Keep entry" onConfirm={() => onAction('removed')} />
    <Menu label="Draft actions" items={[{ value: 'copy', label: 'Make copy' }]} onAction={onAction} />
    <IconButton label="Refresh list" onClick={() => onAction('refreshed')}><span aria-hidden>↻</span></IconButton>
    <Button onClick={() => toast('Sample saved', { action: { label: 'Restore sample', onAction: () => onAction('restored') } })}>Notify editor</Button>
  </>;
}

it('discovers named controls, edits a Draft through component callbacks and operates each popup', async () => {
  const onAction = vi.fn();
  render(<ToastProvider><Controls onAction={onAction} /></ToastProvider>);
  const visible = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more');
  const labels = visible.map(entry => entry.label);
  expect(labels.every(Boolean), JSON.stringify(visible)).toBe(true);
  expect(new Set(labels).size).toBe(labels.length);
  for (const name of ['Draft title', 'Instructions', 'Quantity', 'Priority', 'Include summary', 'Show activity', 'View mode', 'Preview details', 'Review removal', 'Draft actions', 'Refresh list', 'Notify editor']) {
    expect(labels, name).toContain(name);
  }
  const options = await agent.query({ within: 'Priority' });
  if ('error' in options) throw new Error(options.error);
  const urgent = options[0]?.items?.find(item => item.label === 'Urgent');
  expect(urgent).toBeDefined();
  const result = await agent.act({ steps: [
    { ref: 'Draft title', action: 'setValue', args: ['Example'] },
    { ref: 'Instructions', action: 'setValue', args: ['Review tomorrow'] },
    { ref: 'Quantity', action: 'setValue', args: [4] },
    { ref: 'Priority', action: 'setValue', args: [urgent!.label] },
    { ref: 'Include summary', action: 'setChecked', args: [true] },
    { ref: 'Show activity', action: 'setChecked', args: [true] },
    { ref: 'View mode', action: 'setValue', args: ['Detail'] },
    { ref: 'Refresh list', action: 'press' },
    { ref: 'Draft actions', action: 'press', args: ['Make copy'] },
  ] });
  expect(result.ok, result.error?.message).toBe(true);
  expect(onAction).toHaveBeenCalledWith('agent');
  expect(onAction).toHaveBeenCalledWith('refreshed');
  expect(onAction).toHaveBeenCalledWith('copy', expect.anything());
  expect(screen.getByLabelText<HTMLInputElement>('Draft title').value).toBe('Example');
  expect(screen.getByLabelText<HTMLTextAreaElement>('Instructions').value).toBe('Review tomorrow');
  expect(screen.getByLabelText<HTMLInputElement>('Quantity').value).toBe('4');
  expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('combobox').textContent).toContain('Urgent');
  expect(screen.getByText('Detailed entries')).toBeDefined();
  const action = (ref: string, name: string) => agent.act({ steps: [{ ref, action: 'press', args: [name] }] });
  expect((await action('Preview details', 'Open second preview')).ok).toBe(true);
  expect(screen.getByRole('dialog', { name: 'Preview details' })).toBeDefined();
  expect((await action('Preview details', 'Leave preview')).ok).toBe(true);
  expect((await action('Review removal', 'Remove permanently')).ok).toBe(false);
  expect(onAction).not.toHaveBeenCalledWith('removed');
  approve.mockReturnValue(true);
  expect((await action('Review removal', 'Remove permanently')).ok).toBe(true);
  expect(onAction).toHaveBeenCalledWith('removed');
  expect((await press('Notify editor')).ok).toBe(true);
  const notification = agent.snapshot().find(entry => entry.buttons?.includes('Restore sample') && !entry.offPage);
  expect(notification?.label, JSON.stringify(agent.snapshot())).toBeTruthy();
  expect((await action(notification!.ref, 'Restore sample')).ok).toBe(true);
  expect(onAction).toHaveBeenCalledWith('restored');
});

it('requests Clinical Confirmation only for the final action and commits once when approved', async () => {
  const commit = vi.fn();
  render(<InlineConfirmBar trigger="Review sample" confirm="Sign sample" cancel="Keep draft"
    confirmation="Sign this sample?" onConfirm={commit} />);
  expect((await press('Review sample')).ok).toBe(true);
  expect((await press('Keep draft')).ok).toBe(true);
  expect(approve).not.toHaveBeenCalled();
  expect((await press('Review sample')).ok).toBe(true);
  expect((await press('Sign sample')).ok).toBe(false);
  expect(commit).not.toHaveBeenCalled();
  expect(approve).toHaveBeenCalledWith('Sign this sample?', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  approve.mockReturnValue(true);
  expect((await press('Sign sample')).ok).toBe(true);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Sign sample' })).toBeNull();
});

it('keeps the same inline confirmation while an accepted action is pending', async () => {
  const human = userEvent.setup();
  let finish!: () => void;
  const commit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<InlineConfirmBar trigger="Review pending example" confirm="Publish example" cancel="Cancel review"
    confirmation="Publish this example?" onConfirm={commit} />);
  await human.click(screen.getByRole('button', { name: 'Review pending example' }));
  await human.click(screen.getByRole('button', { name: 'Publish example' }));
  await human.click(screen.getByRole('button', { name: 'Cancel review' }));
  expect(screen.getByRole('button', { name: 'Publish example' }).getAttribute('aria-busy')).toBe('true');
  finish();
  expect(commit).toHaveBeenCalledTimes(1);
});

it('shares approval and privacy protections with registered WebMCP tools', async () => {
  const tools = new Map<string, (input: object) => Promise<unknown>>();
  const registerTool = async (tool: { name: string; execute: (input: object) => Promise<unknown> }) => { tools.set(tool.name, tool.execute); };
  Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool } });
  const unregister = agent.registerWebMCP();
  const commit = vi.fn();
  try {
    render(<>
      <Field label="Access key"><Input data-agent-secret /></Field>
      <div data-agent-hidden><Field label="Private recovery"><Input defaultValue="hidden example" /></Field></div>
      <InlineConfirmBar trigger="Inspect change" confirm="Apply change" cancel="Discard review" confirmation="Apply this example?" onConfirm={commit} />
    </>);
    expect([...tools.keys()].sort()).toEqual(['act', 'query', 'snapshot']);
    const execute = (...steps: { ref: string; action: string; args?: unknown[] }[]) => tools.get('act')!({ steps });
    const edit = await execute({ ref: 'Access key', action: 'setValue', args: ['example-private'] });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Access key' }).value).toBe('example-private');
    for (const result of [edit, await tools.get('snapshot')!({}), await tools.get('query')!({ closed: true })]) {
      const exposed = JSON.stringify(result);
      expect(exposed).toContain('[redacted]');
      expect(exposed).not.toMatch(/example-private|Private recovery|hidden example/);
    }
    expect(await execute({ ref: 'Private recovery', action: 'setValue', args: ['changed'] })).toMatchObject({ ok: false });
    expect(await execute({ ref: 'Inspect change', action: 'press' }, { ref: 'Apply change', action: 'press' })).toMatchObject({ ok: false });
    expect(commit).not.toHaveBeenCalled();
    approve.mockReturnValue(true);
    expect(await execute({ ref: 'Apply change', action: 'press' })).toMatchObject({ ok: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(2);
  } finally {
    unregister();
    Reflect.deleteProperty(document, 'modelContext');
  }
});
