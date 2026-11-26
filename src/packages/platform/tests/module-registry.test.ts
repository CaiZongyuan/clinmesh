import { expect, it } from 'vitest';
import { ModuleRegistry, type ClinMeshModule } from '../index';

const platform: ClinMeshModule = { id: 'platform', kind: 'core', version: '1' };
const lab: ClinMeshModule = { id: 'mod-lab', kind: 'clinical', version: '1' };

it('reports the loaded module IDs in registration order', () => {
  const registry = new ModuleRegistry([platform, lab]);
  expect(registry.health('node')).toEqual({
    ok: true, runtime: 'node', loadedModules: ['platform', 'mod-lab'],
  });
});

it('rejects duplicate IDs even with different versions', () => {
  expect(() => new ModuleRegistry([lab, { ...lab, version: '2' }])).toThrow(/duplicate module id: mod-lab/i);
});

it('lets enabled modules contribute to the same operation catalog', () => {
  const registry = new ModuleRegistry<Set<string>>([
    platform,
    { ...lab, registerOperations(catalog) { catalog.add('lab.example'); } },
  ]);
  const catalog = new Set<string>();
  registry.registerOperations(catalog);
  expect([...catalog]).toEqual(['lab.example']);
});
