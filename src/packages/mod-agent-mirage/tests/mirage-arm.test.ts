import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../../operation-catalog';
import { openMirageEnvironment } from '../index';

function operation(name: string) {
  return defineOperation({ name, method: 'GET', path: '/synthetic', access: {} }, z.object({}), z.json(), z.string());
}

it('reads current authorized clinical projections through the mounted VFS and executes only the role’s virtual clinmesh commands', async () => {
  const calls: string[] = [];
  let version = 1;
  const session = openMirageEnvironment({ roleId: 'family-clinician', operations: ['workspace.read', 'encounter.read', 'record.draft'].map(operation), encounterId: () => 'fixed-encounter', async invoke(id, input) {
    calls.push(id);
    if (id === 'workspace.read') return { epoch: 'current', roleId: 'family-clinician', manifest: { packId: 'general' }, caseTruth: 'private-answer' };
    if (id === 'record.draft') { version++; return input; }
    expect(input.id).toBe('fixed-encounter');
    return { id: 'fixed-encounter', status: 'active', version, turns: [], patient: { name: 'Synthetic', identifier: 'private-id' }, priorHistory: {}, caseTruth: 'private-answer' };
  } });
  try {
    expect(await session.inspect('ls', '/')).toContain('workspace');
    expect(await session.inspect('ls', '/')).not.toContain('guidelines');
    expect(await session.inspect('cat', '/workspace/role.json')).not.toMatch(/private|caseTruth/);
    expect(await session.inspect('cat', '/patients/current.json')).not.toMatch(/private|caseTruth|identifier/);
    expect(JSON.parse(await session.inspect('cat', '/encounters/current.json')).version).toBe(1);
    const fields = { note: "An apostrophe ' and $ are plain clinical text." };
    expect(await session.invoke('record.draft', fields)).toEqual(fields);
    expect(JSON.parse(await session.inspect('cat', '/encounters/current.json')).version).toBe(2);
    expect(calls).toEqual(['workspace.read', 'encounter.read', 'encounter.read', 'record.draft', 'encounter.read']);
    await expect(session.inspect('cat', '/patients/case-truth.json')).rejects.toThrow('MIRAGE_PATH_UNAVAILABLE');
    await expect(session.inspect('cat', '/guidelines/current.json')).rejects.toThrow('MIRAGE_PATH_UNAVAILABLE');
    await expect(session.inspect('cat', '/workspace/../encounters/current.json')).rejects.toThrow('MIRAGE_PATH_UNAVAILABLE');
    await expect(session.invoke('workspace.reset', {})).rejects.toThrow('ROLE_FORBIDDEN');
  } finally { await session.close(); }
}, 30000);
