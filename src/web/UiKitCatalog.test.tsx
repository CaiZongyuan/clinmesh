// @vitest-environment jsdom
import '../../scripts/testing/ui-sdk-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createClinMeshUiAgent, ThemeFontProvider, ToastProvider } from '../packages/ui-kit';
import UiKitCatalog from './UiKitCatalog';

const agent = createClinMeshUiAgent();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

function openCatalog(containerWidth: number) {
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, containerWidth, 800));
  return render(<ThemeFontProvider><ToastProvider><UiKitCatalog /></ToastProvider></ThemeFontProvider>);
}

it('names the visible controls in the catalogue and restores device preferences after remounting', async () => {
  const desktop = openCatalog(800);
  const labels = agent.snapshot().filter(entry => !entry.offPage).map(entry => entry.label);
  expect(labels.every(Boolean)).toBe(true);
  expect(new Set(labels).size).toBe(labels.length);
  for (const label of ['Color scheme', 'Font scale', 'Example title', 'Priority', 'Quantity', 'Example secret', 'Draft text', 'Show agent activity', 'Mark as agent draft',
    'Review sample', 'Review removal', 'Reference views', 'Reset examples', 'Show notification', 'Component preview', 'Example actions']) expect(labels).toContain(label);
  const change = await agent.act({ steps: [
    { ref: 'Color scheme', action: 'setValue', args: ['Dark'] }, { ref: 'Font scale', action: 'setValue', args: ['Large · 125%'] },
    { ref: 'Reference views', action: 'setValue', args: ['Reference table'] },
  ] });
  expect(change.ok, change.error?.message).toBe(true);
  expect(screen.getByRole('table', { name: 'Control dimensions' })).toBeDefined();
  expect(await agent.act({ steps: [{ ref: 'Review sample', action: 'press' }, { ref: 'Sign sample', action: 'press' }] })).toMatchObject({ ok: false });
  expect(screen.queryByText('Signed')).toBeNull();
  desktop.unmount();
  openCatalog(799);
  expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', fontScale: 'large' });
  expect(screen.getByRole('button', { name: 'Display preferences' })).toBeDefined();
  expect(screen.queryByRole('combobox', { name: 'Color scheme' })).toBeNull();
  const open = await agent.act({ steps: [{ ref: 'Display preferences', action: 'setOpen', args: [true] }] });
  expect(open.ok, open.error?.message).toBe(true);
  expect(screen.getByRole('combobox', { name: 'Color scheme' }).textContent).toBe('Dark');
  const close = await agent.act({ steps: [{ ref: 'Display preferences', action: 'press', args: ['Close queue'] }] });
  expect(close.ok, close.error?.message).toBe(true);
});
