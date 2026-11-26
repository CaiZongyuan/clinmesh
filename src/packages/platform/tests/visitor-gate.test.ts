import { expect, it, vi } from 'vitest';
import { createVisitorGate } from '../index';

it('signs isolated visitor sessions, verifies purpose and expiration, and confines open mode to loopback', async () => {
  const config = { CLINMESH_SESSION_SECRET: 'synthetic-signing-key-for-platform-tests', CLINMESH_VISITOR_PASSCODE: 'synthetic-pass' };
  const gate = createVisitorGate(config);
  await expect(gate.enter('')).rejects.toMatchObject({ code: 'INVALID_VISITOR_PASSCODE' });
  const first = await gate.enter('synthetic-pass');
  const other = await gate.enter('synthetic-pass');
  expect(first.ticket.workspaceId).not.toBe(other.ticket.workspaceId);
  expect((await gate.authenticate(`cm_visitor=${first.token}`)).ticket).toEqual(first.ticket);
  await expect(gate.authenticate(`cm_visitor=${first.token}0`)).rejects.toMatchObject({ code: 'VISITOR_AUTH_REQUIRED' });
  await expect(gate.authenticate(undefined, `Bearer ${first.token}`)).rejects.toMatchObject({ code: 'VISITOR_AUTH_REQUIRED' });
  vi.useFakeTimers();
  try { vi.setSystemTime(new Date(first.ticket.expiresAt)); await expect(gate.authenticate(`cm_visitor=${first.token}`)).rejects.toMatchObject({ code: 'VISITOR_AUTH_REQUIRED' }); }
  finally { vi.useRealTimers(); }
  expect((await createVisitorGate({ ...config, localOpen: true }).enter('')).ticket.kind).toBe('visitor');
});
