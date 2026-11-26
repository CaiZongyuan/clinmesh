// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmActionButton, createApprovalPrompt, createClinMeshUiAgent, UiAgentApprovalDialog } from '../index';

const prompt = createApprovalPrompt();
const agent = createClinMeshUiAgent(prompt);

afterEach(cleanup);

it('allows a person to deny or approve one request, and withdraws an aborted request', async () => {
  const commit = vi.fn();
  const human = userEvent.setup();
  const sign = (signal?: AbortSignal) => agent.act({ steps: [{ ref: 'Sign example', action: 'press' }] }, { signal });
  render(<><ConfirmActionButton confirmation="Sign this example?" onClick={commit}>Sign example</ConfirmActionButton><UiAgentApprovalDialog prompt={prompt} /></>);
  const denied = sign();
  await screen.findByRole('alertdialog', { name: 'Approve agent action' });
  expect(JSON.stringify(agent.snapshot())).not.toMatch(/Allow once|Approve agent action|Deny request/);
  await human.click(screen.getByRole('button', { name: 'Deny request' }));
  expect((await denied).ok).toBe(false);
  expect(commit).not.toHaveBeenCalled();
  const allowed = sign();
  await human.click(await screen.findByRole('button', { name: 'Allow once' }));
  expect((await allowed).ok).toBe(true);
  const controller = new AbortController();
  const aborted = sign(controller.signal);
  await screen.findByRole('alertdialog');
  controller.abort();
  expect((await aborted).ok).toBe(false);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(commit).toHaveBeenCalledTimes(1);
});
