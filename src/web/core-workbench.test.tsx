// @vitest-environment jsdom
import '../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { teachingGate, withNodeWorkspace } from '../../scripts/testing/node-workspace';
import { afterEach, expect, it, vi } from 'vitest';
import { createClinMeshUiAgent, ThemeFontProvider } from '../packages/ui-kit';
import { App } from './App';

const agent = createClinMeshUiAgent();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('accepts a secret in the Visitor Gate and reports a rejected passcode', async () => {
  vi.stubGlobal('fetch', async (path: string) => Response.json({ code: path.endsWith('/enter') ? 'INVALID_VISITOR_PASSCODE' : 'VISITOR_AUTH_REQUIRED' }, { status: 401 }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App /></ThemeFontProvider></QueryClientProvider>);
  await screen.findByRole('button', { name: 'Enter workspace' });
  expect((await agent.act({ steps: [{ ref: 'Visitor passcode', action: 'setValue', args: ['synthetic-private'] }, { ref: 'Enter workspace', action: 'press' }] })).ok).toBe(true);
  expect(JSON.stringify(agent.snapshot())).not.toContain('synthetic-private');
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Incorrect visitor passcode.');
});

it('discovers the workbench, edits real drafts, and requires human approval for every formal commit', async () => {
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  const transport = globalThis.fetch;
  const human = userEvent.setup();
  const submitted: string[] = [];
  const press = async (ref: string) => { const result = await agent.act({ steps: [{ ref, action: 'press' }] }); expect(result.ok, result.error?.message).toBe(true); };
  const set = async (ref: string, value: string) => { const result = await agent.act({ steps: [{ ref, action: 'setValue', args: [value] }] }); expect(result.ok, result.error?.message).toBe(true); };
  const discover = () => {
    const visible = agent.snapshot().filter(entry => !entry.offPage && entry.component !== 'more');
    expect(visible.every(entry => entry.label)).toBe(true);
    expect(new Set(visible.map(entry => entry.label)).size).toBe(visible.length);
  };
  const formal = async (label: string, suffix: string) => {
    const button = screen.getByRole('button', { name: label });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(button.getAttribute('data-agent-confirm')).toBeTruthy();
    expect((await agent.act({ steps: [{ ref: label, action: 'press' }] })).ok).toBe(false);
    expect(submitted.filter(path => path.endsWith(suffix))).toHaveLength(0);
    await human.click(button);
    await waitFor(() => expect(submitted.filter(path => path.endsWith(suffix))).toHaveLength(1));
  };
  await withNodeWorkspace(async origin => {
    let cookie = '';
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') submitted.push(path);
      const response = await transport(origin + path, { ...init, headers: { ...init?.headers, cookie } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}><ThemeFontProvider><App /></ThemeFontProvider></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Enter workspace' });
    await set('Visitor passcode', teachingGate.CLINMESH_VISITOR_PASSCODE); await press('Enter workspace');
    await screen.findByRole('button', { name: 'Start · Avery Reed' }); discover();
    await press('Start · Avery Reed'); await screen.findByText('I have had a fever and a cough for three days.');
    expect((await agent.act({ steps: [{ ref: 'Role · Intake coordinator', action: 'press', args: ['Family clinician'] }] })).ok).toBe(true);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Question for the patient' }).hasAttribute('disabled')).toBe(false));
    await set('Clinical views', 'Clinical record'); discover();
    for (const label of ['Reason for visit', 'Subjective history', 'Objective findings', 'Assessment', 'Plan']) await set(label, `Synthetic ${label}`);
    await press('Save record draft'); await formal('Sign record', '/clinical-record/sign');
    await screen.findByRole('button', { name: 'View signed revisions' });
    await set('Clinical views', 'Diagnoses'); discover();
    const options = await agent.query({ within: 'Diagnosis catalog' });
    if ('error' in options) throw Error(String(options.error));
    await set('Diagnosis catalog', options[0]!.items!.find(item => item.label.includes('J18.9'))!.label);
    await press('Add diagnosis'); await press('Save diagnosis draft'); await formal('Confirm diagnoses', '/diagnosis/confirm');
    await formal('Complete encounter', '/complete');
    await screen.findByRole('tab', { name: 'Debrief' }); await set('Clinical views', 'Debrief'); await screen.findByRole('heading', { name: 'Case debrief' });
    expect((await agent.act({ steps: [{ ref: 'Role · Family clinician', action: 'press', args: ['Clinic administrator'] }] })).ok).toBe(true);
    await screen.findByRole('button', { name: 'Role · Clinic administrator' });
    await human.click(screen.getByRole('button', { name: 'Teaching outpatient clinic' }));
    await screen.findByRole('button', { name: 'Review epoch reset' }); discover();
    await set('Hospital data pack', 'Teaching cardiovascular centre');
    await press('Review epoch reset'); await formal('Reset epoch', '/workspace/reset');
    await screen.findByRole('heading', { name: '门诊工作台' });
    expect(screen.getByRole('button', { name: '岗位 · 院务管理员' })).toBeDefined();
    expect(screen.getByRole('button', { name: '开诊 · 陈志远' })).toBeDefined();
  });
}, 30_000);
