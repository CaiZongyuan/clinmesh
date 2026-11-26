// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { teachingGate, withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../../packages/ui-kit';
import { App } from '../../App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('lets an agent stage an order while issue and version-specific acknowledgement wait for the responsible human', async () => {
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  const transport = globalThis.fetch;
  const agent = createClinMeshUiAgent();
  const human = userEvent.setup();
  await withNodeWorkspace(async origin => {
    let cookie = '';
    const writes: string[] = [];
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') writes.push(path);
      const response = await transport(origin + path, { ...init, headers: { ...init?.headers, cookie } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App /></ThemeFontProvider></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Enter workspace' });
    const act = (ref: string, action: string, ...args: string[]) => agent.act({ steps: [{ ref, action, args }] });
    await act('Visitor passcode', 'setValue', teachingGate.CLINMESH_VISITOR_PASSCODE);
    await act('Enter workspace', 'press');
    await screen.findByRole('button', { name: 'Start · Jordan Vale' });
    await act('Start · Jordan Vale', 'press');
    await screen.findByRole('heading', { name: 'Jordan Vale' });
    await act('Role · Intake coordinator', 'press', 'Family clinician');
    await screen.findByRole('button', { name: 'Role · Family clinician' });
    expect((await act('Clinical views', 'setValue', 'Investigations')).ok).toBe(true);
    const add = 'Add · High-sensitivity cardiac troponin I';
    await screen.findByRole('button', { name: add });
    expect((await act(add, 'press')).ok).toBe(true);
    const formal = async (label: string, suffix: string) => {
      const button = await screen.findByRole('button', { name: label });
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
      expect(button.getAttribute('data-agent-confirm')).toBeTruthy();
      expect((await act(label, 'press')).ok).toBe(false);
      expect(writes.filter(path => path.endsWith(suffix))).toHaveLength(0);
      await human.click(button);
      await waitFor(() => expect(writes.filter(path => path.endsWith(suffix))).toHaveLength(1));
    };
    await formal('Issue saved orders', '/lab/issue');
    for (const action of ['Accept', 'Start test', 'Report now']) {
      const control = await screen.findByRole('button', { name: new RegExp(`^${action} ·`) });
      await human.click(control);
    }
    await human.click(await screen.findByRole('button', { name: 'Read reports' }));
    await human.click(await screen.findByRole('button', { name: /^Read · High-sensitivity cardiac troponin I/ }));
    expect(await screen.findByText('Initially reported 12 ng/L.')).toBeDefined();
    expect(writes.some(path => path.endsWith('/acknowledge'))).toBe(false);
    await formal('Acknowledge opened reports', '/acknowledge');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Acknowledge opened reports' }).hasAttribute('disabled')).toBe(true));
    await human.click(screen.getByRole('button', { name: 'Close reports' }));
    expect((await act('Role · Family clinician', 'press', 'Cashier')).ok).toBe(true);
    await screen.findByRole('button', { name: 'Role · Cashier' });
    expect((await act('Clinical views', 'setValue', 'Cashier')).ok).toBe(true);
    const charge = await screen.findByRole('checkbox', { name: /^High-sensitivity cardiac troponin I/ });
    expect(charge.closest('tr')?.textContent).toContain('22.00');
    await human.click(charge);
    await human.click(screen.getByRole('button', { name: 'Collect selected charges' }));
    await human.click(await screen.findByRole('button', { name: 'Freeze payment preview' }));
    await human.click(await screen.findByRole('button', { name: 'Close' }));
    await formal('Confirm frozen preview', '/payment.confirm');
  });
}, 30_000);
