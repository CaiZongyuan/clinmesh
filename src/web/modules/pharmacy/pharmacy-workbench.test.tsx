// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { openPharmacySession } from '../../../../scripts/testing/pharmacy-session';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../../packages/ui-kit';
import { App } from '../../App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('lets the UI agent stage medication and batch choices while reserving dispensing, signing and withdrawal for a person', async () => {
  const agent = createClinMeshUiAgent();
  const human = userEvent.setup();
  const transport = globalThis.fetch;
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  const act = (ref: string, action: 'press' | 'setValue', args?: string[]) => agent.act({ steps: [{ ref, action, args }] });
  const guarded = async (label: string) => {
    const button = screen.getByRole('button', { name: label });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(button.getAttribute('data-agent-confirm')).toBeTruthy();
    expect((await act(label, 'press')).ok).toBe(false);
    return button;
  };
  await withNodeWorkspace(async origin => {
    const session = await openPharmacySession((path, init) => transport(origin + path, init));
    await session.start('Avery Reed', 'J18.9');
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => transport(origin + path, { ...init, headers: { ...init?.headers, cookie: session.cookie } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    await screen.findByRole('tab', { name: 'Prescriptions' });
    expect((await act('Clinical views', 'setValue', ['Prescriptions'])).ok).toBe(true);
    await screen.findByRole('button', { name: 'Add · Amoxicillin' });
    expect((await act('Add · Amoxicillin', 'press')).ok).toBe(true);
    expect(await screen.findByText('Confirmed drug allergy')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign prescription' }).hasAttribute('disabled')).toBe(true);
    await act('Remove · Amoxicillin', 'press');
    await act('Add · Doxycycline', 'press');
    await human.click(await guarded('Sign prescription'));
    const withdraw = await screen.findByRole('button', { name: /^Withdraw prescription ·/ });
    await human.type(screen.getByRole('textbox', { name: /^Withdrawal reason ·/ }), 'Reviewed');
    await guarded(withdraw.textContent!);
    await human.click(await guarded('Complete encounter'));
    await screen.findByRole('tab', { name: 'Debrief' });
    expect((await act('Role · Family clinician', 'press', ['Clinical pharmacist'])).ok).toBe(true);
    const confirm = await screen.findByRole('button', { name: /^Confirm dispense ·/ });
    expect(screen.getByText(/Confirmed allergies · penicillin/)).toBeDefined();
    const manual = screen.getByRole('switch', { name: /^Select batches manually/ });
    manual.focus(); await human.keyboard(' ');
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await human.type(screen.getByRole('spinbutton', { name: 'Dispense units · Doxycycline · GEN-A' }), '1');
    await human.click(await guarded(confirm.textContent!));
    expect(await screen.findByText('No prescriptions are ready to dispense.')).toBeDefined();
    cleanup(); client.clear();
  });
}, 45000);
