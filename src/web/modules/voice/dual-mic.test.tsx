// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebSocket as NodeWebSocket } from 'ws';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { createClinMeshUiAgent, ThemeFontProvider } from '../../../packages/ui-kit';
import { encounterViewSchema } from '../../../packages/clinical-core';
import { summarySchema } from '../../../packages/patient-visit';
import { App } from '../../App';
import { createVoiceDesk } from './voice-desk';

class Recognition {
  static sessions: Recognition[] = [];
  onresult?: (event: object) => void;
  onspeechstart?: () => void;
  onend?: () => void;
  start() { Recognition.sessions.push(this); }
  stop = vi.fn();
  abort = vi.fn();
  transcript(text: string, isFinal: boolean) { this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] }); }
}
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Recognition.sessions.length = 0; });

it('sends consultation voice to the Patient Agent and Ambient, interrupts playback, and keeps a held assistant instruction out of Consultation', async () => {
  const transport = globalThis.fetch;
  const agent = createClinMeshUiAgent();
  vi.stubGlobal('SpeechRecognition', Recognition);
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
  const speech = { speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal('speechSynthesis', speech);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  await withNodeWorkspace(async origin => {
    let cookie = '';
    const questions: object[] = [], instructions: string[] = [];
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (path.endsWith('/consultation/turns')) questions.push(JSON.parse(String(init?.body)));
      if (path === '/api/assistant/turn') instructions.push(String(init?.body));
      const response = await transport(origin + path, { ...init, headers: { ...init?.headers, cookie } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    });
    vi.stubGlobal('WebSocket', class extends NodeWebSocket { constructor(url: URL) { super(origin.replace('http:', 'ws:') + url.pathname + url.search, { origin, headers: { cookie } }); } });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Enter workspace' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start · Avery Reed' }));
    await screen.findByRole('heading', { name: 'Avery Reed' });
    const step = async (ref: string, action: string, ...args: (string | boolean)[]) => {
      const result = await agent.act({ steps: [{ ref, action, args }] }); expect(result.ok, result.error?.message).toBe(true);
    };
    await step('Role · Intake coordinator', 'press', 'Family clinician');
    await screen.findByRole('button', { name: 'Start consultation mic' });
    await step('Model settings', 'press'); await step('Mock Mode', 'setChecked', true); await step('Model and provider settings', 'press', 'Close model settings');
    await step('Voice settings', 'press'); await step('Voice engine', 'setValue', 'Browser Web Speech'); await step('Bailian voice key', 'setValue', 'synthetic-browser-only');
    expect(JSON.stringify(agent.snapshot())).not.toContain('synthetic-browser-only');
    await step('Read patient replies aloud', 'setChecked', true); await step('Voice settings', 'press', 'Close voice settings');
    expect(screen.getByText('Consultation mic muted')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Clinician Assistant · Ready/ }));
    await screen.findByText('Connected'); await userEvent.click(screen.getByRole('switch', { name: 'Ambient Mode' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Ambient Mode' }).getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(screen.getByRole('button', { name: 'Start consultation mic' }));
    const main = Recognition.sessions[0]!;
    act(() => main.transcript('Where', false)); await screen.findByText('Where'); expect(questions).toHaveLength(0);
    act(() => main.transcript('Where does it hurt?', true));
    await screen.findByText('Breathing deeply hurts my right side.', {}, { timeout: 10000 });
    await waitFor(() => expect(speech.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'Breathing deeply hurts my right side.' })));
    act(() => main.onspeechstart?.()); expect(speech.cancel).toHaveBeenCalled();
    expect(questions).toMatchObject([{ content: 'Where does it hurt?', channel: 'voice' }]);
    await waitFor(() => expect(instructions.join('')).toContain('consultation.final'), { timeout: 10000 });
    const ptt = screen.getByRole('button', { name: 'Hold to dictate to assistant' });
    expect(agent.snapshot().map(item => item.label)).toContain('Hold to dictate to assistant');
    fireEvent.pointerDown(ptt, { button: 0, pointerId: 1 });
    expect(main.abort).toHaveBeenCalled(); await screen.findByText('Consultation mic muted');
    const assistant = Recognition.sessions.at(-1)!;
    fireEvent.pointerUp(ptt, { pointerId: 1 }); expect(assistant.stop).toHaveBeenCalled();
    act(() => { main.transcript('Stale clinic frame', true); assistant.transcript('Private assistant instruction', true); assistant.onend?.(); });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Instruction to assistant' }).value).toBe('Private assistant instruction');
    expect(questions).toHaveLength(1);
    const encounters = z.array(summarySchema).parse(await (await transport(`${origin}/api/his/encounters`, { headers: { cookie } })).json());
    const detail = encounterViewSchema.parse(await (await transport(`${origin}/api/his/encounters/${encounters[0]!.id}`, { headers: { cookie } })).json());
    expect(detail.turns).toEqual(expect.arrayContaining([expect.objectContaining({ speaker: 'clinician', channel: 'voice', content: 'Where does it hurt?' })]));
    expect(JSON.stringify(detail.turns)).not.toMatch(/Private assistant|Stale clinic|synthetic-browser-only/);
    cleanup();
  }, true);
}, 40_000);

it('offers BYOK only in the handshake and drains a short private utterance captured before network readiness', async () => {
  const stop = vi.fn(), message = vi.fn(), closeContext = vi.fn(async () => {});
  const streams: { port: { onmessage?: (event: { data: unknown }) => void } }[] = [];
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { mediaDevices: { getUserMedia } }));
  vi.stubGlobal('AudioContext', class { state = 'running'; audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {}, disconnect() {} }; } close = closeContext; });
  vi.stubGlobal('AudioWorkletNode', class { port = { onmessage: undefined as ((event: { data: unknown }) => void) | undefined, close() {}, postMessage: () => this.port.onmessage?.({ data: 'finished' }) }; constructor() { streams.push(this); } disconnect() {} });
  class BrowserSocket {
    static OPEN = 1; static CLOSING = 2; static sockets: BrowserSocket[] = [];
    readyState = 1; bufferedAmount = 0; send = vi.fn(); close = vi.fn(); onopen?: () => void; onmessage?: (event: { data: string }) => void;
    constructor(readonly url: URL, readonly protocols: string[]) { BrowserSocket.sockets.push(this); }
    frame(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  vi.stubGlobal('WebSocket', BrowserSocket);
  const desk = createVoiceDesk({ epoch: crypto.randomUUID(), encounterId: crypto.randomUUID() });
  try {
    desk.configure({ token: 'synthetic-private-voice' });
    desk.start('consultation', 'en-US', message);
    const main = BrowserSocket.sockets[0]!;
    expect(main.url.search).not.toContain('synthetic-private-voice'); main.onopen?.();
    expect(main.protocols).toEqual(['clinmesh.voice.v1', 'byok.c3ludGhldGljLXByaXZhdGUtdm9pY2U']);
    expect(main.send.mock.calls).toEqual([[JSON.stringify({ type: 'start_call' })]]);
    await waitFor(() => expect(streams).toHaveLength(1));
    main.frame({ type: 'status', status: 'listening' });
    const pcm = new Int16Array(1600).buffer;
    streams[0]!.port.onmessage?.({ data: { pcm, speech: true } }); expect(main.send).toHaveBeenLastCalledWith(pcm);
    const assistant = vi.fn(); desk.start('assistant', 'en-US', assistant); expect(stop).toHaveBeenCalled(); expect(main.close).toHaveBeenCalledOnce();
    main.frame({ type: 'transcript', role: 'user', text: 'late transcript' }); expect(message).not.toHaveBeenCalled();
    const privateSocket = BrowserSocket.sockets[1]!;
    await waitFor(() => expect(streams).toHaveLength(2));
    const pressed = new Int16Array(128).fill(9).buffer, afterRelease = new Int16Array(128).fill(17).buffer;
    streams[1]!.port.onmessage?.({ data: { pcm: pressed, speech: true } });
    desk.release('assistant'); expect(stop).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    streams[1]!.port.onmessage?.({ data: { pcm: afterRelease, speech: true } });
    privateSocket.onopen?.(); privateSocket.frame({ type: 'status', status: 'listening' });
    await waitFor(() => expect(privateSocket.send.mock.calls).toEqual([[JSON.stringify({ type: 'start_call' })], [pressed], [JSON.stringify({ type: 'end_call' })]]));
    privateSocket.frame({ type: 'transcript', role: 'user', text: 'Private' }); privateSocket.frame({ type: 'status', status: 'idle' });
    expect(assistant.mock.calls).toEqual([['Private']]); expect(message).not.toHaveBeenCalled();
    desk.start('assistant', 'en-US', assistant); BrowserSocket.sockets[2]!.frame({ type: 'error', message: 'VOICE_UNCONFIGURED' });
    expect(desk.state.getState()).toMatchObject({ mic: undefined, error: 'VOICE_UNCONFIGURED' });
  } finally { desk.close(); }
  expect(closeContext).toHaveBeenCalledOnce();
});

it('retains the text consultation and assistant while the host disables mod-voice', async () => {
  const transport = globalThis.fetch;
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 800));
  await withNodeWorkspace(async origin => {
    let cookie = '';
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      const response = await transport(origin + path, { ...init, headers: { ...init?.headers, cookie } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie; return response;
    });
    render(<QueryClientProvider client={new QueryClient()}><ThemeFontProvider><App/></ThemeFontProvider></QueryClientProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Enter workspace' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start · Avery Reed' }));
    const agent = createClinMeshUiAgent();
    expect((await agent.act({ steps: [{ ref: 'Role · Intake coordinator', action: 'press', args: ['Family clinician'] }] })).ok).toBe(true);
    const assistant = await screen.findByRole('button', { name: /Clinician Assistant · Ready/ });
    await userEvent.click(assistant);
    expect(screen.getByLabelText('Question for the patient')).toBeTruthy(); expect(screen.getByLabelText('Instruction to assistant')).toBeTruthy();
    expect(screen.queryByText(/Start consultation mic|Voice settings|Hold to dictate/)).toBeNull();
    expect((await transport(`${origin}/api/voice/session`, { headers: { cookie } })).status).toBe(404);
    cleanup();
  }, true, { CLINMESH_VOICE_ENABLED: '0' });
}, 30000);
