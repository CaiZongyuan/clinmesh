import { v7 } from 'uuid';
import { z } from 'zod';

export class CoreError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, readonly code: string, readonly details?: Readonly<Record<string, string | number>>) { super(code); }
}

const identity = z.strictObject({ kind: z.literal('visitor'), workspaceId: z.uuidv7(), id: z.uuidv7(), expiresAt: z.iso.datetime() });
const ticket = z.discriminatedUnion('kind', [identity, identity.extend({ kind: z.literal('capability'), epoch: z.uuidv7() })]);
export type Ticket = z.infer<typeof ticket>;
export type Credential = { ticket: Ticket; tokenHash?: string };
export type GateSettings = { CLINMESH_VISITOR_PASSCODE?: string; CLINMESH_SESSION_SECRET?: string; localOpen?: boolean; loadSigningSecret?: () => Promise<string> };
const encoder = new TextEncoder();
const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async (text: string) => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const unauthorized = () => new CoreError(401, 'VISITOR_AUTH_REQUIRED');
export function createVisitorGate(settings: GateSettings) {
  let imported: Promise<CryptoKey> | undefined;
  async function importKey() {
    const secret = settings.CLINMESH_SESSION_SECRET || await settings.loadSigningSecret?.();
    if (!secret || secret.length < 32) throw new CoreError(503, 'VISITOR_GATE_UNCONFIGURED');
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  const key = () => imported ??= importKey();
  async function sign(claims: Ticket) {
    const body = btoa(JSON.stringify(claims)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
    return `${body}.${toHex(await crypto.subtle.sign('HMAC', await key(), encoder.encode(body)))}`;
  }
  async function verify(token: string, kind: Ticket['kind']): Promise<Credential> {
    const match = /^([\w-]{1,1024})\.([0-9a-f]{64})$/u.exec(token);
    if (!match) throw unauthorized();
    const signature = Uint8Array.from(match[2]!.match(/../g)!, byte => parseInt(byte, 16));
    if (!await crypto.subtle.verify('HMAC', await key(), signature, encoder.encode(match[1]!))) throw unauthorized();
    const claims = ticket.parse(JSON.parse(atob(match[1]!.replaceAll('-', '+').replaceAll('_', '/'))));
    if (claims.kind !== kind || Date.parse(claims.expiresAt) <= Date.now()) throw unauthorized();
    return { ticket: claims, tokenHash: kind === 'capability' ? await sha256(token) : undefined };
  }
  return {
    async enter(passcode: string) {
      if (!settings.localOpen) {
        if (!settings.CLINMESH_VISITOR_PASSCODE) throw new CoreError(503, 'VISITOR_GATE_UNCONFIGURED');
        const comparison = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
        const digest = await crypto.subtle.sign('HMAC', comparison, encoder.encode(settings.CLINMESH_VISITOR_PASSCODE));
        if (!await crypto.subtle.verify('HMAC', comparison, digest, encoder.encode(passcode))) throw new CoreError(401, 'INVALID_VISITOR_PASSCODE');
      }
      const claims = { kind: 'visitor' as const, workspaceId: v7(), id: v7(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
      return { ticket: claims, token: await sign(claims) };
    },
    authenticate(cookie?: string, bearer?: string) {
      if (bearer !== undefined) return verify(bearer.startsWith('Bearer ') ? bearer.slice(7) : '', 'capability');
      const value = cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('cm_visitor='));
      return verify(value?.slice('cm_visitor='.length) ?? '', 'visitor');
    }, sign,
  };
}
