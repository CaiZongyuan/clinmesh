// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../../web/App';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../ui-kit';
import { configuredPharmacy } from './configured-pharmacy';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('offers both authorized workbenches to a combined prescribing and dispensing role', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  const { store, fetchApi, session } = await configuredPharmacy(pack => { pack.organization.practitionerRoles.find(role => role.id === 'family-clinician')!.capabilities.push('dispense'); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    vi.stubGlobal('fetch', fetchApi);
    await session.start('Avery Reed', 'J18.9');
    render(<QueryClientProvider client={client}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    await screen.findByRole('tab', { name: 'Prescriptions' });
    const agent = createClinMeshUiAgent();
    const desk = (name: string) => agent.act({ steps: [{ ref: 'Workbench', action: 'setValue', args: [name] }] });
    expect((await desk('Dispensing queue')).ok).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Dispensing queue' })).toBeDefined();
    expect((await desk('Clinical workbench')).ok).toBe(true);
    expect(await screen.findByRole('tab', { name: 'Prescriptions' })).toBeDefined();
  } finally { cleanup(); client.clear(); await store.close(); }
});
