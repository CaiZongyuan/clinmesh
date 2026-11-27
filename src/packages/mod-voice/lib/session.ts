import { z } from 'zod';
import { type BailianConnect } from './bailian';
import { SambertTTSProvider, voiceName } from './sambert';
import { ParaformerTranscriber, type Transcriber } from './transcriber';

export const voiceError = z.enum(['VOICE_UNCONFIGURED', 'VOICE_AUTH_FAILED', 'VOICE_RATE_LIMITED', 'VOICE_TIMEOUT', 'VOICE_PROVIDER_FAILED', 'VOICE_INVALID_RESPONSE', 'VOICE_INVALID_PCM', 'VOICE_AUDIO_BACKLOG', 'VOICE_INVALID_FRAME', 'VOICE_SECRET_IN_INPUT']);
export const voiceServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['listening', 'done']) }), z.object({ type: z.enum(['partial', 'final']), text: z.string().min(1).max(8000) }), z.object({ type: z.literal('error'), code: voiceError }),
]);
export const voiceBinding = z.strictObject({ epoch: z.uuidv7(), encounterId: z.uuidv7() });
const token = z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/).optional();
const start = z.discriminatedUnion('type', [z.strictObject({ type: z.literal('listen'), token }), z.strictObject({ type: z.literal('speak'), token, text: z.string().trim().min(1).max(8000), voice: voiceName.optional() })]);
const finish = z.strictObject({ type: z.literal('finish') });
export type VoiceSocket = { send(data: string | ArrayBuffer): void; close(code: number): void };

export function openVoiceSession(socket: VoiceSocket, connect: BailianConnect, hostToken?: string) {
  const controller = new AbortController();
  let listening: ReturnType<Transcriber['createSession']> | undefined;
  let initialized = false, finishing = false;
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
    try { emit({ type: 'error', code: voiceError.safeParse(error instanceof Error && error.message).data ?? 'VOICE_PROVIDER_FAILED' }); } finally { close(); }
  }
  function done() { try { emit({ type: 'done' }); } finally { close(); } }
  async function synthesize(provider: SambertTTSProvider, text: string, voice?: string) {
    const audio = await provider.synthesize(text, { voice, signal: controller.signal });
    if (controller.signal.aborted) return;
    for (let offset = 0; offset < audio.byteLength; offset += 32000) socket.send(audio.slice(offset, offset + 32000));
    done();
  }
  return { close, receive(data: unknown) {
    if (controller.signal.aborted) return;
    try {
      if (listening && !finishing && data instanceof ArrayBuffer) { listening.feed(data); return; }
      if (typeof data !== 'string' || data.length > 16384) throw Error();
      const frame: unknown = JSON.parse(data);
      if (initialized) {
        if (!listening || finishing || !finish.safeParse(frame).success) throw Error();
        finishing = true; void listening.close().then(done, fail); return;
      }
      const request = start.parse(frame);
      initialized = true;
      const credential = request.token ?? token.parse(hostToken || undefined);
      if (!credential) return fail(Error('VOICE_UNCONFIGURED'));
      clearTimeout(timeout);
      timeout = setTimeout(() => fail(Error('VOICE_TIMEOUT')), 30 * 60 * 1000);
      if (request.type === 'listen') {
        listening = new ParaformerTranscriber(credential, connect).createSession({ signal: controller.signal, onPartial: text => emit({ type: 'partial', text }), onFinal: text => emit({ type: 'final', text }), onFatalError: fail });
        emit({ type: 'listening' });
      } else void synthesize(new SambertTTSProvider(credential, connect), request.text, request.voice).catch(fail);
    } catch { fail(Error('VOICE_INVALID_FRAME')); }
  } };
}
