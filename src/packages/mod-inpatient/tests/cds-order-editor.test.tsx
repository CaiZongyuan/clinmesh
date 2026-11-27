// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../ui-kit';
import { App } from '../../../web/App';
import { prepareCompletedPci } from './cds-journey';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('loads the actual screened PCI set into the ward order composer and signs only the reviewed order', async () => {
  const http = globalThis.fetch;
  const human = userEvent.setup();
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  await withNodeWorkspace(async origin => {
    const { ward, read, stage, item } = await prepareCompletedPci((path, init) => http(origin + path, init));
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) => http(origin + path, { ...init, headers: { ...init?.headers, cookie: ward.cookie } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    const agent = createClinMeshUiAgent();
    const choose = async (ref: string, value: string) => waitFor(async () => expect((await agent.act({ steps: [{ ref, action: 'setValue', args: [value] }] })).ok).toBe(true));
    await screen.findByRole('combobox', { name: '工作台' }); await choose('工作台', '住院工作台');
    await screen.findByRole('tab', { name: '手术' }); await choose('住院阶段', '手术');
    await human.click(await screen.findByRole('button', { name: 'PCI 术后用药复核' }));
    expect(screen.getAllByRole('checkbox', { checked: true }).length).toBeGreaterThanOrEqual(3);
    await human.click(screen.getByRole('button', { name: '灌入草稿' }));
    await screen.findByText('草稿已灌入，请到开单页核对。');
    expect((await read()).orders).toEqual([]);
    await human.click(screen.getByRole('button', { name: '关闭组套' }));
    const dose = await screen.findByRole('textbox', { name: /单次剂量/ });
    await human.type(dose, '100');
    const button = screen.getByRole('button', { name: '签发医嘱' });
    expect(button.getAttribute('data-agent-confirm')).toBeTruthy();
    expect((await agent.act({ steps: [{ ref: '签发医嘱', action: 'press' }] })).ok).toBe(false);
    await human.click(button);
    await waitFor(async () => expect((await read()).orders).toMatchObject([{ itemId: item('aspirin'), surgeryExecutionId: stage.executionId, directions: { dose: 100 } }]));
  });
}, 60_000);
