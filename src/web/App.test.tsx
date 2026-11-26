// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function showHealth(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

it('renders the runtime and module IDs returned by the API', async () => {
  showHealth({ ok: true, runtime: 'cloudflare-worker', loadedModules: ['mod-lab'] });
  expect(await screen.findByText('cloudflare-worker')).toBeDefined();
  expect(screen.getByText('mod-lab')).toBeDefined();
});

it('reports an unavailable health service rather than inventing a healthy runtime', async () => {
  showHealth({ ok: false });
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Health data unavailable.');
});
