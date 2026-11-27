// @vitest-environment jsdom
import '../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { teachingGate, withNodeWorkspace } from '../../scripts/testing/node-workspace';
import { openAiText, withProvider } from '../../scripts/testing/agent-provider';
import { createClinMeshUiAgent, ThemeFontProvider } from '../packages/ui-kit';
import { App } from './App';

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('configures both agents privately, probes explicit Mock Mode, and asks the patient in the workbench', async () => {
  const transport = globalThis.fetch;
  const agent = createClinMeshUiAgent();
  const act = async (ref: string, action: string, ...args: (string | boolean)[]) => {
    const result = await agent.act({ steps: [{ ref, action, args }] });
    expect(result.ok, result.error?.message).toBe(true);
  };
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  await withNodeWorkspace(async origin => {
    let cookie = '';
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      const response = await transport(origin + path, { ...init, headers: { ...init?.headers, cookie } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    await screen.findByRole('button', { name: 'Enter workspace' });
    await act('Visitor passcode', 'setValue', teachingGate.CLINMESH_VISITOR_PASSCODE); await act('Enter workspace', 'press');
    await screen.findByRole('button', { name: 'Start · Avery Reed' });
    await act('Start · Avery Reed', 'press'); await screen.findByRole('heading', { name: 'Avery Reed' });
    await act('Role · Intake coordinator', 'press', 'Family clinician');
    await waitFor(() => expect(screen.getByLabelText('Question for the patient').hasAttribute('disabled')).toBe(false));
    await act('Question for the patient', 'setValue', 'Where does it hurt?'); await act('Send question', 'press');
    await screen.findByText('Configure a provider or enable Mock Mode.');
    await act('Model settings', 'press'); await screen.findByRole('dialog');
    await act('Provider', 'setValue', 'OpenAI-compatible'); await act('API key', 'setValue', 'synthetic-browser-only');
    expect(JSON.stringify(agent.snapshot())).not.toContain('synthetic-browser-only');
    await act('Patient model override', 'setValue', 'short-patient'); await act('Clinician model override', 'setValue', 'long-clinician');
    await act('Patient reasoning', 'setValue', 'low'); await act('Clinician reasoning', 'setValue', 'high');
    await act('Mock Mode', 'setChecked', true); await act('Test patient provider', 'press'); await screen.findByText('Connection successful.');
    await act('Model and provider settings', 'press', 'Close model settings'); await screen.findByText('Mock Mode');
    await act('Send question', 'press'); await screen.findByText('Breathing deeply hurts my right side.');
  });
}, 30_000);

it('resumes the selected older encounter, stops during generation, and repairs an asynchronous authentication failure in place', async () => {
  const transport = globalThis.fetch;
  const agent = createClinMeshUiAgent();
  const act = async (ref: string, action: string, ...args: (string | boolean)[]) => {
    const result = await agent.act({ steps: [{ ref, action, args }] }); expect(result.ok, result.error?.message).toBe(true);
  };
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  let requests = 0;
  await withProvider(51928, (request, response) => {
    requests++;
    if (requests === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'test', model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'unapproved-stream-fragment' }, finish_reason: null }] })}\n\n`);
    } else if (request.headers.authorization !== 'Bearer synthetic-renewed') { response.writeHead(401); response.end(); }
    else openAiText(response, 'I felt it yesterday.');
  }, async baseUrl => {
    await withNodeWorkspace(async origin => {
      let cookie = '';
      const subscriptions: string[] = [];
      vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
        if (path.includes('/events?')) subscriptions.push(path);
        const response = await transport(origin + path, { ...init, headers: { ...init?.headers, cookie } });
        cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie; return response;
      });
      const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
      const initial = mount();
      await screen.findByRole('button', { name: 'Enter workspace' });
      await act('Visitor passcode', 'setValue', teachingGate.CLINMESH_VISITOR_PASSCODE); await act('Enter workspace', 'press');
      await screen.findByRole('button', { name: 'Start · Avery Reed' });
      await act('Start · Avery Reed', 'press'); await screen.findByRole('heading', { name: 'Avery Reed' });
      await act('Start · Jordan Vale', 'press'); await screen.findByRole('heading', { name: 'Jordan Vale' });
      const older = screen.getByRole('button', { name: /^Avery Reed · .*Active$/ });
      await act(older.textContent!, 'press'); await screen.findByRole('heading', { name: 'Avery Reed' });
      await act('Role · Intake coordinator', 'press', 'Family clinician');
      await screen.findByRole('button', { name: 'Role · Family clinician' });
      await act('Model settings', 'press'); await screen.findByRole('dialog');
      await act('Mock Mode', 'setChecked', false); await act('Provider', 'setValue', 'Server default');
      await act('API key', 'setValue', 'synthetic-expired'); await act('Model and provider settings', 'press', 'Close model settings');
      await act('Question for the patient', 'setValue', 'When did you notice it?'); await act('Send question', 'press');
      await screen.findByText(/Receiving the patient reply/);
      expect(document.body.textContent).not.toContain('unapproved-stream-fragment');
      initial.unmount(); mount();
      await screen.findByRole('heading', { name: 'Avery Reed' }); await screen.findByText(/Receiving the patient reply/);
      expect(requests).toBe(1); expect(new Set(subscriptions).size).toBe(1);
      await act('Stop patient reply', 'press'); await screen.findByText('Patient reply stopped.');
      await act('Retry patient reply', 'press'); await screen.findByText('The provider rejected the credential. Check your API key.');
      await act('Edit reply provider', 'press'); await screen.findByRole('dialog');
      await act('API key', 'setValue', 'synthetic-renewed'); await act('Model and provider settings', 'press', 'Close model settings');
      await act('Retry patient reply', 'press'); await screen.findByText('I felt it yesterday.');
      await waitFor(() => expect(document.querySelectorAll('.consultation-turns li')).toHaveLength(3));
      expect(requests).toBe(3); expect(new Set(subscriptions).size).toBe(1);
    }, false, { CLINMESH_LLM_BASE_URL: baseUrl, CLINMESH_LLM_MODEL: 'synthetic-model' });
  });
}, 30_000);
