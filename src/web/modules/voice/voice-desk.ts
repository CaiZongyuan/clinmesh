import { createStore } from 'zustand/vanilla';
import { z } from 'zod';
import { bailianMic, bailianSpeak, type Binding } from './bailian-client';
import { browserMic, browserSpeak, type MicEvents } from './browser-speech';

const preferences = z.object({ engine: z.enum(['bailian', 'browser']).default('bailian'), token: z.string().max(2048).default(''), aloud: z.boolean().default(false) });
const storageKey = 'clinmesh.voice.v1';
type Preferences = z.infer<typeof preferences>;
function read() { try { return preferences.parse(JSON.parse(localStorage.getItem(storageKey) ?? '{}')); } catch { return preferences.parse({}); } }
type Channel = 'consultation' | 'assistant';
type State = { settings: Preferences; mic?: Channel; ready: boolean; finishing: boolean; partial: string; playing: boolean; error?: string; errorChannel?: Channel };

export function createVoiceDesk(binding: Binding) {
  const state = createStore<State>(() => ({ settings: read(), partial: '', ready: false, finishing: false, playing: false }));
  let capture: AbortController | undefined, playback: AbortController | undefined, context: AudioContext | undefined;
  let drain: (() => void) | undefined, drainTimeout: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: unknown, errorChannel: Channel = 'consultation') => state.setState({ errorChannel, error: error instanceof Error && /^VOICE_[A-Z_]+$/.test(error.message) ? error.message : 'VOICE_MEDIA_FAILED' });
  function audioContext() {
    if (!window.AudioContext) throw Error('VOICE_AUDIO_UNAVAILABLE');
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(fail);
    return context;
  }
  function interrupt() { playback?.abort(); playback = undefined; state.setState({ playing: false }); }
  function mute(channel?: Channel) {
    if (channel && state.getState().mic !== channel) return;
    const old = capture;
    capture = undefined; drain = undefined; clearTimeout(drainTimeout); old?.abort();
    state.setState({ mic: undefined, partial: '', ready: false, finishing: false });
  }
  function start(channel: Channel, lang: string, final: (text: string) => void) {
    mute(); interrupt();
    const control = new AbortController();
    capture = control;
    state.setState({ mic: channel, error: undefined });
    const { engine, token } = state.getState().settings;
    const secret = (text: string) => Boolean(token && text.includes(token));
    const events: MicEvents = {
      ready() { if (capture === control) state.setState({ ready: true }); },
      speech() { if (capture === control && playback) interrupt(); },
      partial(text) { if (capture === control && !secret(text)) { if (text) events.speech(); state.setState({ partial: text }); } },
      final(text) {
        if (capture !== control) return;
        if (secret(text)) { events.end(Error('VOICE_SECRET_IN_INPUT')); return; }
        events.speech(); state.setState({ partial: '' }); final(text);
      },
      end(error) { if (capture === control) { mute(); if (error) fail(error, channel); } },
    };
    try { drain = engine === 'browser' ? browserMic(lang, events, control.signal) : bailianMic(binding, token, audioContext(), events, control.signal); }
    catch (error) { events.end(error instanceof Error ? error : Error('VOICE_MIC_UNAVAILABLE')); }
  }
  function release(channel: Channel) {
    if (state.getState().mic !== channel || state.getState().finishing) return;
    state.setState({ finishing: true });
    drainTimeout = setTimeout(() => { mute(); fail(Error('VOICE_TIMEOUT'), channel); }, 7000);
    drain?.();
  }
  async function speak(text: string, lang: string) {
    const { engine, token, aloud } = state.getState().settings;
    if (!aloud || state.getState().mic === 'assistant') return;
    interrupt();
    const control = new AbortController(); playback = control; state.setState({ playing: true });
    try {
      if (engine === 'bailian') await bailianSpeak(binding, token, text, audioContext(), control.signal);
      else await browserSpeak(text, lang, control.signal);
    } catch (error) { if (!control.signal.aborted) fail(error); }
    finally { if (playback === control) { playback = undefined; state.setState({ playing: false }); } }
  }
  function configure(change: Partial<Preferences>) {
    mute(); interrupt();
    const settings = preferences.parse({ ...state.getState().settings, ...change });
    state.setState({ settings, error: undefined });
    localStorage.setItem(storageKey, JSON.stringify(settings));
    if (change.aloud && settings.engine === 'bailian') { try { audioContext(); } catch (error) { fail(error); } }
  }
  return { state, start, mute, release, interrupt, speak, configure, close() { mute(); interrupt(); if (context) void context.close().catch(() => {}); context = undefined; } };
}
