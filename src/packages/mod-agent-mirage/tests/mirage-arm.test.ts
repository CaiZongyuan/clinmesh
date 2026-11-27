import { expect, it } from 'vitest';
import { z } from 'zod';
import { v7 } from 'uuid';
import general from '../../../../data/packs/global-general/pack.json';
import { studyWorkspace } from '../../../../scripts/testing/study-workspace';
import { parseHospitalDataPack } from '../../data-pack';
import { defineOperation } from '../../operation-catalog';
import { openMirageEnvironment } from '../index';

function operation(name: string) {
  return defineOperation({ name, method: 'GET', path: '/synthetic', access: {} }, z.object({}), z.json(), z.string());
}

it('reads current authorized clinical projections through the mounted VFS and executes only the role’s virtual clinmesh commands', async () => {
  const calls: string[] = [];
  let version = 1;
  const encounter = v7();
  const session = openMirageEnvironment({ roleId: 'family-clinician', operations: ['workspace.read', 'encounter.read', 'record.draft'].map(operation), encounterId: () => encounter, async invoke(id, input) {
    calls.push(id);
    if (id === 'workspace.read') return { epoch: 'current', roleId: 'family-clinician', manifest: { packId: 'general' }, cases: [{ demographics: { identifiers: ['private-id'] } }], caseTruth: 'private-answer' };
    if (id === 'record.draft') { version++; return input; }
    expect(input.id).toBe(encounter);
    return { id: encounter, status: 'active', version, turns: [], patient: { name: 'Synthetic', birthDate: '1981-01-01', identifiers: ['private-id'] }, caseTruth: 'private-answer' };
  } });
  try {
    expect(await session.inspect('ls', '/')).toContain('workspace');
    expect(await session.inspect('ls', '/')).not.toContain('guidelines');
    expect(await session.inspect('cat', '/workspace/role.json')).not.toMatch(/private|caseTruth/);
    expect(JSON.parse(await session.inspect('cat', '/encounters/current.json')).version).toBe(1);
    const fields = { note: "An apostrophe ' and $ are plain clinical text." };
    expect(await session.invoke('record.draft', fields)).toEqual(fields);
    expect(JSON.parse(await session.inspect('cat', '/encounters/current.json')).version).toBe(2);
    expect(calls).toEqual(['workspace.read', 'workspace.read', 'workspace.read', 'encounter.read', 'record.draft', 'encounter.read']);
    for (const name of ['workspace.read', 'encounter.read']) expect(JSON.stringify(await session.invoke(name, name === 'workspace.read' ? {} : { id: encounter }))).not.toMatch(/private|caseTruth|identifiers|birthDate|1981-01-01/);
    await expect(session.inspect('cat', '/patients/case-truth.json')).rejects.toThrow('MIRAGE_PATH_UNAVAILABLE');
    await expect(session.inspect('cat', '/guidelines/current.json')).rejects.toThrow('MIRAGE_PATH_UNAVAILABLE');
    await expect(session.inspect('cat', '/workspace/../encounters/current.json')).rejects.toThrow('MIRAGE_PATH_UNAVAILABLE');
    await expect(session.invoke('workspace.reset', {})).rejects.toThrow('ROLE_FORBIDDEN');
  } finally { await session.close(); }
}, 30000);

it('projects the same real workspace and bound encounter for the terminal and mounted role views', async () => {
  const host = await studyWorkspace(parseHospitalDataPack(general));
  try {
    const patient = (await host.encounter()).patient;
    const environment = openMirageEnvironment({ roleId: (await host.workspace()).roleId, operations: ['workspace.read', 'encounter.read'].map(operation), encounterId: () => host.encounterId, invoke: async name => name === 'workspace.read' ? host.workspace() : host.encounter() });
    try {
      const views = await Promise.all([environment.invoke('workspace.read', {}), environment.invoke('encounter.read', { id: host.encounterId }), environment.inspect('cat', '/patients/current.json')]);
      expect(JSON.stringify(views)).toContain(patient.name);
      for (const secret of [patient.birthDate, ...patient.identifiers.map(item => item.value)]) expect(JSON.stringify(views)).not.toContain(secret);
    } finally { await environment.close(); }
  } finally { await host.close(); }
}, 30000);
