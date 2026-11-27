// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { studyWorkspace } from '../../../../scripts/testing/study-workspace';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../ui-kit';
import { App } from '../../../web/App';
import { parseHospitalDataPack } from '../../data-pack';
import diagnostic from '../../../../data/packs/diagnostic-teaching/pack.json';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('fills radiology and pathology drafts with exactly the screened studies and collects the required specimen link before issue', async () => {
  const pack = structuredClone(parseHospitalDataPack(diagnostic));
  pack.manifest.enabledModules.push('mod-cds', 'mod-fhir-r5');
  pack.knowledge!.orderSetTemplates.push({ id: 'study-review', name: { en: 'Study review', zh: '检查会诊' }, scope: 'outpatient', triggerDiagnoses: [], hardContraindications: [], requiredEvidence: [], members: pack.catalog.services.filter(item => ['XR', 'CONSULT'].includes(item.code)).map(item => ({ kind: 'services', codeSystem: item.codeSystem, code: item.code })) });
  const host = await studyWorkspace(pack);
  try {
    const human = userEvent.setup();
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => host.request(path, init));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    const agent = createClinMeshUiAgent();
    const pick = async (name: string) => waitFor(async () => expect((await agent.act({ steps: [{ ref: 'Clinical views', action: 'setValue', args: [name] }] })).ok).toBe(true));
    await screen.findByRole('tab', { name: 'Decision support' }); await pick('Decision support');
    await human.click(await screen.findByRole('button', { name: 'Study review' }));
    await human.click(screen.getByRole('button', { name: 'Fill draft' }));
    await screen.findByText('Draft ready for review in the order editor.');
    expect((await host.study('imaging').view()).orders).toEqual([]);
    expect((await host.study('pathology').view()).orders).toEqual([]);
    await human.click(screen.getByRole('button', { name: 'Close order set' })); await pick('Radiology');
    const radiograph = await screen.findByRole('button', { name: 'Issue staged request · Chest radiograph' });
    expect(radiograph.getAttribute('data-agent-confirm')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue staged request · Noncontrast chest CT' })).toBeNull();
    await human.click(radiograph); await waitFor(async () => expect((await host.study('imaging').view()).orders).toHaveLength(1));
    await pick('Pathology');
    const pathology = await screen.findByRole('button', { name: 'Issue staged request · Surgical pathology consultation' });
    expect(pathology.hasAttribute('disabled')).toBe(true);
    await human.click(screen.getByRole('combobox', { name: 'Related prior surgery' }));
    await human.click(await screen.findByRole('option', { name: /Excision of a chest wall nodule/ }));
    expect((await agent.act({ steps: [{ ref: 'Issue staged request · Surgical pathology consultation', action: 'press' }] })).ok).toBe(false);
    await human.click(pathology);
    await waitFor(async () => expect((await host.study('pathology').view()).orders).toMatchObject([{ priorSurgeryId: 'excision-01' }]));
  } finally { await host.close(); }
}, 30_000);
