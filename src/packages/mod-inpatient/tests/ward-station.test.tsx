// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../ui-kit';
import { App } from '../../../web/App';
import { wardClient } from './ward-client';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('opens the real Chinese workbench and protects ward bed assignment behind human confirmation', () => withNodeWorkspace(async origin => {
  const transport = globalThis.fetch;
  const ward = await wardClient((path, init) => transport(origin + path, init));
  const encounterId = await ward.admit('赵德明');
  await ward.role('ward-nurse');
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => transport(origin + path, { ...init, headers: { ...init?.headers, cookie: ward.cookie } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
  const agent = createClinMeshUiAgent();
  const assign = await screen.findByRole('button', { name: '确认分床或转床' });
  expect(assign.getAttribute('data-agent-confirm')).toBeTruthy();
  expect((await agent.act({ steps: [{ ref: '确认分床或转床', action: 'press' }] })).ok).toBe(false);
  expect(await ward.get(`/api/his/ward/${encounterId}`)).toMatchObject({ status: 'registered', bed: null });
  await userEvent.setup().click(assign);
  await waitFor(async () => expect(await ward.get(`/api/his/ward/${encounterId}`)).toMatchObject({ status: 'admitted', bed: 'heart-01' }));
  expect(screen.getAllByRole('tab').map(node => node.textContent)).toEqual(['入科分床', '诊断医嘱', '检查检验', '手术', '出院', '病案']);
  expect((await agent.act({ steps: [{ ref: '住院阶段', action: 'setValue', args: ['手术'] }] })).ok).toBe(true);
  expect(screen.queryByRole('button', { name: '签发手术申请' })).toBeNull();
  cleanup(); client.clear();
}, false, { CLINMESH_PORT: '51964' }), 30_000);
