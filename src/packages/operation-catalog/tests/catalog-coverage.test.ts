import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createOperationCatalog } from '../../../server/operation-catalog';
import { createApp } from '../../../server/app';
import { builtinModules } from '../../../server/builtin-modules';
import { createWorkspaceApp } from '../../../server/workspace';
import { createNodeSqliteStore } from '../../store';
import type { OperationCatalog } from '../../platform';
import { describeOperation, type OperationDescription } from '../index';

const hostExceptions = {
  'GET /api/health': 'Public liveness and installed-module check before the Visitor Gate.',
  'ALL /api/*': 'Authenticates requests and dispatches to the workspace router.',
  'ALL /fhir/R5': 'Authenticates the read-only FHIR interoperability gateway.',
  'ALL /fhir/R5/*': 'Authenticates resource requests for the FHIR projection.',
};
const workspaceExceptions = {
  'POST /api/auth/visitor/enter': 'Bootstraps the browser Visitor Gate and cookie.',
  'POST /api/eval/runs': 'Explicit isolated Evaluation Run admission.',
  'GET /api/eval/runs/:id': 'Evaluation owner retrieves the separate run report.',
  'POST /api/assistant/sessions': 'Browser SDK thread lifecycle for the clinician assistant.',
  'POST /api/assistant/availability': 'Browser SDK probes the configured provider.',
  'POST /api/assistant/observations': 'Encounter-bound ambient observations on the browser channel.',
  'POST /api/assistant/turn': 'Browser SDK submits or rejoins a durable model turn.',
  'POST /api/assistant/stop': 'Browser SDK interrupts its active turn.',
  'GET /api/assistant/bridge': 'Browser WebSocket bridge for interactive UI tools.',
  'GET /api/voice/session': 'Visitor-bound voice WebSocket subprotocol carries transient audio and BYOK.',
  'POST /api/agents/providers/test': 'Tests transient browser BYOK provider configuration.',
  'GET /api/agents/sessions/:id/events': 'Patient Agent event-stream transport for the consultation.',
  'GET /api/his/encounters/:id/debrief': 'Private Case Truth for the responsible visitor after completion.',
  'ALL /fhir/R5': 'FHIR R5 has its own read-only resource and error protocol.',
  'ALL /fhir/R5/*': 'FHIR R5 resource/search/history grammar is validated by the projection.',
};
const offline: OperationDescription[] = JSON.parse(readFileSync('src/cli/operations.json', 'utf8'));
const key = ({ method, path }: { method: string; path: string }) => `${method} ${path}`;

it('accounts for every actual host and workspace Hono route exactly once, including protocol-only surfaces', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const host = createApp('node', {}, () => Response.error(), builtinModules);
    const workspace = createWorkspaceApp(store, {}, builtinModules);
    expect(host.routes.map(key).sort()).toEqual(Object.keys(hostExceptions).sort());
    const routes = offline.map(entry => key(entry.http));
    const expected = [...routes, ...Object.keys(workspaceExceptions)];
    expect(new Set(expected).size).toBe(expected.length);
    expect(workspace.routes.map(key).sort()).toEqual(expected.sort());
  } finally { await store.close(); }
});

it('publishes matching versioned schemas, confirmation and module access from the live registrations', () => {
  const live = createOperationCatalog(builtinModules).catalog.entries;
  expect(offline).toEqual(live.map(entry => JSON.parse(JSON.stringify(describeOperation(entry.contract)))));
  const contract = (id: string) => offline.find(entry => entry.id === id)!;
  expect(contract('lab.acknowledge')).toMatchObject({ cliPath: 'lab report acknowledge', risk: 'high-risk-write', moduleId: 'mod-lab', allowedCapabilities: ['review-reports'], expectedVersionFields: ['expectedVersion', 'reportVersion'], requiresIdempotencyKey: true, visitorOnly: false });
  expect(contract('payment.preview')).toMatchObject({ mode: 'preview', risk: 'write', visitorOnly: true, requiresIdempotencyKey: true });
  expect(contract('lab.amend').visitorOnly).toBe(true);
  expect(contract('lab.issue').expectedVersionFields).toContain('items[].catalogVersion');
  expect(contract('imaging.issue').expectedVersionFields).toContain('item.catalogVersion');
  expect(contract('pathology.issue').expectedVersionFields).toContain('item.catalogVersion');
  for (const [name, allowed] of [['encounter.read', [7]], ['encounter.start', [5, 7]], ['ward.register', [5, 7]]] as const) {
    const wire = live.find(entry => entry.name === name)!.contract.paramsSchema;
    const decoded = z.fromJSONSchema(contract(name).inputSchema);
    expect(decoded).toBeInstanceOf(z.ZodObject);
    for (const version of [4, 5, 7]) {
      const id = `0191abcd-1111-${version}000-8000-000000000001`;
      const valid = allowed.some(value => value === version);
      expect(wire.safeParse({ id }).success).toBe(valid);
      expect((decoded as z.ZodObject).shape.id!.safeParse(id).success).toBe(valid);
    }
  }
  expect(contract('prescription.sign').visitorOnly).toBe(true);
  const prescribing = contract('prescription.sign').inputSchema.properties!;
  expect(prescribing.clinicalOverride).toMatchObject({ required: ['reasonCode', 'note', 'ruleCodes'], properties: { reasonCode: { enum: expect.arrayContaining(['specialist-judgment']) }, note: { minLength: 4 }, ruleCodes: { minItems: 1 } } });
  expect(prescribing).not.toHaveProperty('override'); expect(prescribing).not.toHaveProperty('overrideReason');
  expect(contract('ward.surgery.complete').visitorOnly).toBe(true);
  expect(JSON.stringify(offline)).not.toMatch(/caseTruth|case_truth|\/debrief/iu);
  expect(live.filter(entry => entry.assistantRead).map(entry => entry.name).sort()).toEqual(['catalog.diagnoses', 'cds.guidelines', 'cds.order-sets', 'cds.scores', 'encounter.read', 'imaging.read', 'lab.read', 'pathology.read', 'prescription.read']);
});

it('keeps the module receiver when the workspace composes operations', async () => {
  class Census {
    id = 'mod-census'; kind = 'clinical' as const; version = '1';
    registerOperations(catalog: OperationCatalog) {
      catalog.query({ name: `${this.id}.list`, path: '/api/census', access: {} }, z.array(z.string()), () => []);
    }
  }
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try { expect(createWorkspaceApp(store, {}, [new Census()]).routes.map(key)).toContain('GET /api/census'); }
  finally { await store.close(); }
});

it('resolves every skill example through the operation paths and schema IDs', () => {
  const skill = readFileSync('skills/clinmesh/SKILL.md', 'utf8');
  const commands = Array.from(skill.matchAll(/\bclinmesh (?=[a-z-])([^\r\n`]+)/g), match => match[1]!.trim());
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    const path = command.split(/ --/)[0]!;
    if (path.startsWith('operations schema ')) expect(offline.some(entry => entry.id === path.slice('operations schema '.length))).toBe(true);
    else expect(['operations list', ...offline.map(entry => entry.cliPath)]).toContain(path);
  }
});
