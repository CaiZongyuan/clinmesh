// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { v7 } from 'uuid';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import general from '../../../../data/packs/global-general/pack.json';
import { createWorkspaceApp } from '../../../server/workspace';
import { App } from '../../../web/App';
import { installHospitalDataPack, readHospitalDataPack } from '../../data-pack';
import type { Credential } from '../../platform';
import { createNodeSqliteStore } from '../../store';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../ui-kit';
import { encounterViewSchema } from '../index';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('amends the currently visible record after a local birthday and displays every field actually signed in older revisions', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const workspaceId = v7();
  const id = v7();
  const credential: Credential = { ticket: { kind: 'visitor', workspaceId, id, expiresAt: '2099-01-01T00:00:00Z' } };
  try {
    const pack = { ...general, manifest: { ...general.manifest, timezone: 'Asia/Shanghai', clinicalRecordTemplate: [
      { id: 'concern', title: { en: 'Concern', zh: '主诉' }, required: true },
      { id: 'minor', title: { en: 'Guardian note', zh: '监护记录' }, required: true, showWhen: { maxAge: 17 } },
    ] }, cases: general.cases.map(item => ({ ...item, demographics: { ...item.demographics, birthDate: '2010-04-17' } })) };
    const at = await store.withTransaction(tx => {
      const scope = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: '2028-04-16T15:59:59Z' }, pack);
      tx.insert(scope, 'visitor_sessions', { id, practitioner_role: 'family-clinician', expires_at: credential.ticket.expiresAt, version: 1, revoked: false });
      return scope;
    });
    const app = createWorkspaceApp(store, {});
    const send = (path: string, init?: RequestInit) => app.request(path, init, { credential, entering: false });
    const command = (path: string, method: string, expectedVersion: number, fields: Record<string, unknown> = {}) => send(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, epoch: at.epoch, expectedVersion, idempotencyKey: v7() }) });
    const caseId = await store.read(reader => readHospitalDataPack(reader, at)!.cases[0]!.id);
    const opened = z.object({ encounterId: z.uuidv7() }).parse(await (await command(`/api/his/cases/${caseId}/start-encounter`, 'POST', 0)).json());
    const path = `/api/his/encounters/${opened.encounterId}`;
    expect((await command(`${path}/clinical-record/draft`, 'PUT', 1, { expectedDraftVersion: 0, fields: { concern: 'First concern', minor: 'Signed with guardian' } })).status).toBe(200);
    expect((await command(`${path}/clinical-record/sign`, 'POST', 2)).status).toBe(200);
    expect((await command('/api/workspace/role', 'POST', 1, { roleId: 'coordinator' })).status).toBe(200);
    expect((await command('/api/workspace/advance-time', 'POST', 0, { to: '2028-04-16T16:00:00Z' })).status).toBe(200);
    expect((await command('/api/workspace/role', 'POST', 2, { roleId: 'family-clinician' })).status).toBe(200);
    expect(await (await command(`${path}/clinical-record/draft`, 'PUT', 3, { expectedDraftVersion: 1, fields: { concern: 'Rejected', minor: 'Past age limit' } })).json()).toEqual({ code: 'FIELD_NOT_IN_TEMPLATE' });
    vi.stubGlobal('fetch', send);
    const agent = createClinMeshUiAgent();
    const human = userEvent.setup();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    await screen.findByRole('tab', { name: 'Clinical record' });
    expect((await agent.act({ steps: [{ ref: 'Clinical views', action: 'setValue', args: ['Clinical record'] }] })).ok).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Guardian note' })).toBeNull();
    await human.click(screen.getByRole('button', { name: 'View signed revisions' }));
    const history = screen.getByRole('dialog', { name: 'Signed records' });
    expect(within(history).getByText('Guardian note')).toBeDefined();
    expect(within(history).getByText('Signed with guardian')).toBeDefined();
    await human.click(within(history).getByRole('button', { name: 'Close record history' }));
    expect((await agent.act({ steps: [{ ref: 'Concern', action: 'setValue', args: ['Amended at eighteen'] }, { ref: 'Save record draft', action: 'press' }] })).ok).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign record' }).hasAttribute('disabled')).toBe(false));
    await human.click(screen.getByRole('button', { name: 'Sign record' }));
    await waitFor(async () => expect(encounterViewSchema.parse(await (await send(path)).json()).recordRevisions.map(item => item.fields)).toEqual([
      { concern: 'First concern', minor: 'Signed with guardian' }, { concern: 'Amended at eighteen' },
    ]));
  } finally { await store.close(); }
});
