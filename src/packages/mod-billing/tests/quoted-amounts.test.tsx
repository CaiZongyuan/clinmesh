// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import general from '../../../../data/packs/global-general/pack.json';
import { studyWorkspace } from '../../../../scripts/testing/study-workspace';
import { App } from '../../../web/App';
import { parseHospitalDataPack } from '../../data-pack';
import { ThemeFontProvider } from '../../ui-kit';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([['JPY', 0, 'JPY 9007199254740991'], ['USD', 2, 'USD 90071992547409.91']] as const)('shows the exact %s minor-unit amount on investigation quotes, formal approval and the resulting bill', async (code, minorUnitExponent, expected) => {
  const pack = structuredClone(parseHospitalDataPack(general));
  pack.manifest.currency = { code, minorUnitExponent, symbol: code };
  pack.manifest.enabledModules.push('mod-imaging');
  pack.catalog.services.find(item => item.kind === 'registration')!.unitPriceMinor = 0;
  pack.catalog.services.find(item => item.code === 'chest-xray')!.unitPriceMinor = Number.MAX_SAFE_INTEGER;
  pack.catalog.services.find(item => item.code === 'cbc')!.unitPriceMinor = Number.MAX_SAFE_INTEGER;
  const host = await studyWorkspace(pack);
  try {
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => host.request(path, init));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Investigations' }));
    expect((await screen.findByRole('button', { name: 'Add · Complete blood count' })).closest('li')!.textContent).toContain(expected);
    await user.click(await screen.findByRole('tab', { name: 'Radiology' }));
    const issue = await screen.findByRole('button', { name: 'Issue · Chest radiograph' });
    expect(issue.closest('li')!.textContent).toContain(expected);
    expect(issue.getAttribute('data-agent-confirm')).toContain(expected);
    await user.click(issue);
    await waitFor(async () => expect((await host.study('imaging').view()).orders).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Role · Family clinician' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cashier' }));
    await screen.findByRole('button', { name: 'Role · Cashier' });
    await user.click(await screen.findByRole('tab', { name: 'Cashier' }));
    await screen.findByRole('heading', { name: 'Account balance' });
    expect((await screen.findAllByText(expected, { exact: false })).length).toBeGreaterThan(0);
  } finally { await host.close(); }
}, 30000);
