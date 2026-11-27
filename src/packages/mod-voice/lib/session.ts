import { z } from 'zod';
import { type BailianConnect } from './bailian';
import { SambertTTSProvider, voiceName } from './sambert';
import { ParaformerTranscriber, type Transcriber } from './transcriber';
import { voiceError, voiceServerFrame } from './protocol';

export const voiceBinding = z.strictObject({ epoch: z.uuidv7(), encounterId: z.uuidv7() });
const input = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), protocol_version: z.literal(1).optional() }),
  z.strictObject({ type: z.literal('start_call'), preferred_format: z.enum(['mp3', 'wav', 'pcm16', 'opus']).optional() }),
  z.strictObject({ type: z.enum(['end_call', 'start_of_speech', 'end_of_speech', 'interrupt']) }),
  z.strictObject({ type: z.literal('speak'), text: z.string().trim().min(1).max(8000), voice: voiceName.optional() }),
]);
export type VoiceSocket = { send(data: string | ArrayBuffer): void; close(code: number): void };

export function openVoiceSession(socket: VoiceSocket, connect: BailianConnect, credential?: string) {
  const controller = new AbortController();
  let listening: ReturnType<Transcriber['createSession']> | undefined;
  let phase: 'idle' | 'listening' | 'draining' | 'speaking' = 'idle';
  let timeout = setTimeout(() => fail(Error('VOICE_TIMEOUT')), 10000);
  function close() {
    if (controller.signal.aborted) return;
    controller.abort(); clearTimeout(timeout); socket.close(1000);
  }
  function emit(frame: z.infer<typeof voiceServerFrame>) {
    if (!controller.signal.aborted) socket.send(JSON.stringify(frame));
  }
  function fail(error: unknown) {
    if (controller.signal.aborted) return;
    const message = voiceError.safeParse(error instanceof Error && error.message).data ?? 'VOICE_PROVIDER_FAILED';
    try { emit({ type: 'error', message, ...(listening && { stage: 'stt', code: 'stt_connection_lost', retryable: true }) }); } finally { close(); }
  }
  function done() { try { emit({ type: 'done' }); } finally { close(); } }
  async function synthesize(provider: SambertTTSProvider, text: string, voice?: string) {
    const audio = await provider.synthesize(text, { voice, signal: controller.signal });
    if (controller.signal.aborted) return;
    for (let offset = 0; offset < audio.byteLength; offset += 32000) socket.send(audio.slice(offset, offset + 32000));
    done();
  }
  function idle() { phase = 'idle'; listening = undefined; emit({ type: 'status', status: 'idle' }); }
  emit({ type: 'welcome', protocol_version: 1 }); idle();
  return { close, receive(data: unknown) {
    if (controller.signal.aborted) return;
    try {
      if (listening && phase === 'listening' && data instanceof ArrayBuffer) { listening.feed(data); return; }
      if (typeof data !== 'string' || data.length > 16384) throw Error();
      const request = input.parse(JSON.parse(data));
      if (request.type === 'hello' || request.type === 'start_of_speech' || request.type === 'end_of_speech' || request.type === 'interrupt') return;
      if (request.type === 'end_call') {
        if (phase === 'listening' && listening) { phase = 'draining'; void listening.close().then(idle, fail); }
        return;
      }
      if (phase !== 'idle') throw Error();
      if (!credential) return fail(Error('VOICE_UNCONFIGURED'));
      clearTimeout(timeout);
      timeout = setTimeout(() => fail(Error('VOICE_TIMEOUT')), 30 * 60 * 1000);
      if (request.type === 'start_call') {
        phase = 'listening';
        listening = new ParaformerTranscriber(credential, connect).createSession({ signal: controller.signal, onInterim: text => emit({ type: 'transcript_interim', text }), onUtterance: text => emit({ type: 'transcript', role: 'user', text }), onFatalError: fail });
        emit({ type: 'status', status: 'listening' });
      } else if (request.type === 'speak') { phase = 'speaking'; void synthesize(new SambertTTSProvider(credential, connect), request.text, request.voice).catch(fail); }
    } catch { fail(Error('VOICE_INVALID_FRAME')); }
  } };
}
