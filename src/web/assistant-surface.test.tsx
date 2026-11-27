// @vitest-environment jsdom
import '../../scripts/testing/ui-sdk-dom';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmActionButton, Field, Textarea } from '../packages/ui-kit';
import { createAssistantSurface } from './assistant-surface';
import { createAmbientQueue } from './assistant-channel';

afterEach(cleanup);
it('uses the same scoped approval for WebMCP and the native bridge, and preserves a focused or manually edited draft', async () => {
  const send = vi.fn();
  const root = document.createElement('div'); document.body.appendChild(root);
  const surface = createAssistantSurface(() => root, new Set());
  const tools = new Map<string, (data: object) => Promise<unknown>>();
  Object.defineProperty(document, 'modelContext', { configurable: true, value: { async registerTool(tool: { name: string; execute(data: object): Promise<unknown> }) { tools.set(tool.name, tool.execute); } } });
  const stop = surface.mount();
  try {
    const human = userEvent.setup();
    render(<div><Field label="Presenting concern" data-assistant-field="record:concern"><Textarea /></Field><ConfirmActionButton confirmation="Sign this reviewed note?" onClick={send}>Sign note</ConfirmActionButton></div>, { container: root });
    render(<ConfirmActionButton confirmation="Elsewhere" onClick={send}>Other workspace action</ConfirmActionButton>);
    const field = screen.getByRole('textbox', { name: 'Presenting concern' });
    const write = () => surface.call({ tool: 'ui_act', args: { steps: [{ ref: 'Presenting concern', action: 'setValue', args: ['Assistant draft'] }] } }, new AbortController().signal);
    await act(async () => { await write(); });
    expect((field as HTMLTextAreaElement).value).toBe('Assistant draft');
    await human.click(field);
    await act(async () => { await write(); });
    expect(surface.state.getState().suggestions).toHaveLength(1);
    await human.clear(field); await human.type(field, 'Human draft'); await human.tab();
    await act(async () => { await write(); });
    expect((field as HTMLTextAreaElement).value).toBe('Human draft');
    expect(surface.state.getState().protected).toContain('record:concern');
    await act(async () => { await surface.accept(surface.state.getState().suggestions[0]!); });
    expect((field as HTMLTextAreaElement).value).toBe('Assistant draft');
    const args = { steps: [{ ref: 'Sign note', action: 'press' }] };
    const declined = surface.call({ tool: 'ui_act', args }, new AbortController().signal);
    await waitFor(() => expect(surface.state.getState().approval?.message).toBe('Sign this reviewed note?'));
    surface.state.getState().approval!.answer(false);
    expect(await declined).toMatchObject({ ok: false }); expect(send).not.toHaveBeenCalled();
    const applied = tools.get('act')!(args);
    await waitFor(() => expect(surface.state.getState().approval).toBeDefined());
    surface.state.getState().approval!.answer(true); await applied;
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await tools.get('snapshot')!({}))).not.toContain('Other workspace action');
    expect(await surface.call({ tool: 'ui_act', args: { steps: [{ ref: 'Other workspace action', action: 'press' }] } }, new AbortController().signal)).toMatchObject({ ok: false });
  } finally { stop(); root.remove(); Reflect.deleteProperty(document, 'modelContext'); }
});

it('coalesces finalized observations across the 1.2 second debounce and active clinician turns', async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn(async (_events: string[]) => {});
    const queue = createAmbientQueue(send);
    queue.add(['turn:1']); queue.add(['report:1', 'turn:1']);
    await vi.advanceTimersByTimeAsync(1199); expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(send.mock.calls).toEqual([[['turn:1', 'report:1']]]);
    queue.busy(true); queue.add(['report:2']); await vi.advanceTimersByTimeAsync(1400);
    expect(send).toHaveBeenCalledTimes(1); queue.busy(false);
    await vi.advanceTimersByTimeAsync(1200); expect(send).toHaveBeenCalledTimes(2);
    queue.add(['turn:2']); queue.close(); await vi.advanceTimersByTimeAsync(1200); expect(send).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
