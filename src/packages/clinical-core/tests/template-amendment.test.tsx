// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../../web/App';
import { createNodeSqliteStore } from '../../store';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../ui-kit';
import { templateFixture } from './template-fixture';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['unchanged', 'persisted', 'local', 'mixed'])('requires a clinical decision about %s amendments when template fields retire on a local birthday', async scenario => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const { workspaceId, at, opened, path, send, command, read, birthday } = await templateFixture(store);
    expect((await command(`${path}/clinical-record/draft`, 'PUT', 1, { expectedDraftVersion: 0, fields: { concern: 'First concern', minor: 'Signed with guardian' } })).status).toBe(200);
    expect((await command(`${path}/clinical-record/sign`, 'POST', 2)).status).toBe(200);
    expect((await command(`${path}/diagnosis/draft`, 'PUT', 3, { diagnoses: [{ codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'J18.9', primary: true }] })).status).toBe(200);
    expect((await command(`${path}/diagnosis/confirm`, 'POST', 4)).status).toBe(200);
    const persisted = scenario === 'persisted' || scenario === 'mixed';
    const local = scenario === 'local' || scenario === 'mixed';
    if (persisted) expect((await command(`${path}/clinical-record/draft`, 'PUT', 5, { expectedDraftVersion: 1, fields: { concern: 'First concern', minor: 'Saved correction' } })).status).toBe(200);
    expect((await read()).completion.ready).toBe(!persisted);
    vi.stubGlobal('fetch', send);
    const agent = createClinMeshUiAgent();
    const human = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    await screen.findByRole('tab', { name: 'Clinical record' });
    expect((await agent.act({ steps: [{ ref: 'Clinical views', action: 'setValue', args: ['Clinical record'] }] })).ok).toBe(true);
    if (local) expect((await agent.act({ steps: [{ ref: 'Guardian note', action: 'setValue', args: ['Local correction'] }] })).ok).toBe(true);
    expect(await birthday()).toEqual([200, 200, 200]);
    await act(async () => { await client.invalidateQueries({ queryKey: [workspaceId, at.epoch, opened.encounterId, 'clinical'], exact: true }); });
    const afterBirthday = await read();
    expect(afterBirthday.completion.ready).toBe(!persisted);
    expect(screen.getByRole('button', { name: 'Complete encounter' }).hasAttribute('disabled')).toBe(local || persisted);
    if (persisted) {
      expect(await (await command(`${path}/complete`, 'POST', afterBirthday.version)).json()).toEqual({ code: 'COMPLETION_BLOCKED' });
      expect(await (await command(`${path}/clinical-record/sign`, 'POST', afterBirthday.version)).json()).toEqual({ code: 'RETIRED_FIELDS_REQUIRE_REVIEW' });
      expect(await (await command(`${path}/clinical-record/sign`, 'POST', afterBirthday.version, { expectedDraftVersion: afterBirthday.draftVersion, retiredReview: { decision: 'include', localFields: { unknown: 'Not a template field' } } })).json()).toEqual({ code: 'INVALID_RETIRED_FIELD_REVIEW' });
      expect((await read()).recordRevisions.length).toBe(1);
    }
    expect(await (await command(`${path}/clinical-record/draft`, 'PUT', afterBirthday.version, { expectedDraftVersion: afterBirthday.draftVersion, fields: { concern: 'Rejected', minor: 'Past age limit' } })).json()).toEqual({ code: 'FIELD_NOT_IN_TEMPLATE' });
    expect(screen.queryByRole('textbox', { name: 'Guardian note' })).toBeNull();
    await human.click(screen.getByRole('button', { name: 'View signed revisions' }));
    const history = screen.getByRole('dialog', { name: 'Signed records' });
    expect(within(history).getByText('Guardian note')).toBeDefined();
    expect(within(history).getByText('Signed with guardian')).toBeDefined();
    await human.click(within(history).getByRole('button', { name: 'Close record history' }));
    expect((await agent.act({ steps: [{ ref: 'Concern', action: 'setValue', args: ['Amended at eighteen'] }, { ref: 'Save record draft', action: 'press' }] })).ok).toBe(true);
    const signLabel = scenario === 'unchanged' ? 'Sign record' : scenario === 'mixed' ? 'Discard corrections and sign' : 'Include corrections and sign';
    await waitFor(() => expect(screen.getByRole('button', { name: signLabel }).hasAttribute('disabled')).toBe(false));
    if (local || persisted) {
      expect(screen.getByText('Last signed · Signed with guardian')).toBeDefined();
      expect(screen.getByText(`Saved draft · ${persisted ? 'Saved correction' : 'Signed with guardian'}`)).toBeDefined();
      if (local) expect(screen.getByText('Unsaved edit · Local correction')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Sign record' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: 'Complete encounter' }).hasAttribute('disabled')).toBe(true);
      expect((await agent.act({ steps: [{ ref: signLabel, action: 'press' }] })).ok).toBe(false);
    }
    await human.click(screen.getByRole('button', { name: signLabel }));
    const signed = scenario === 'persisted' ? { minor: 'Saved correction' } : scenario === 'local' ? { minor: 'Local correction' } : {};
    await waitFor(async () => expect((await read()).recordRevisions.map(item => item.fields)).toEqual([
      { concern: 'First concern', minor: 'Signed with guardian' }, { concern: 'Amended at eighteen', ...signed },
    ]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Complete encounter' }).hasAttribute('disabled')).toBe(false));
    expect((await command(`${path}/complete`, 'POST', (await read()).version)).status).toBe(200);
  } finally { await store.close(); }
});
