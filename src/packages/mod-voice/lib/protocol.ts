import { z } from 'zod';

const protocol = 'clinmesh.voice.v1';
const key = z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/);
export function voiceProtocols(token: string) {
  if (!token) return [protocol];
  const encoded = btoa(key.parse(token)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return [protocol, `byok.${encoded}`];
}
export function voiceHandshake(header?: string): { protocol?: string; token?: string } {
  if (!header) return {};
  const [first, credential] = z.tuple([z.literal(protocol), z.string().regex(/^byok\.[a-zA-Z0-9_-]{2,2731}$/).optional()]).parse(header.split(',').map(part => part.trim()));
  if (!credential) return { protocol: first };
  const encoded = z.base64url().parse(credential.slice(5));
  return { protocol: first, token: key.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))) };
}

export const voiceError = z.enum(['VOICE_UNCONFIGURED', 'VOICE_AUTH_FAILED', 'VOICE_RATE_LIMITED', 'VOICE_TIMEOUT', 'VOICE_PROVIDER_FAILED', 'VOICE_INVALID_RESPONSE', 'VOICE_INVALID_PCM', 'VOICE_AUDIO_BACKLOG', 'VOICE_INVALID_FRAME', 'VOICE_SECRET_IN_INPUT']);
const text = z.string().min(1).max(8000);
export const voiceServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), protocol_version: z.literal(1) }), z.object({ type: z.literal('status'), status: z.enum(['idle', 'listening']) }),
  z.object({ type: z.literal('transcript_interim'), text }), z.object({ type: z.literal('transcript'), role: z.literal('user'), text }),
  z.object({ type: z.literal('done') }), z.object({ type: z.literal('error'), message: voiceError, code: z.enum(['stt_startup_failed', 'stt_connection_lost']).optional(), stage: z.literal('stt').optional(), retryable: z.boolean().optional() }),
]);
