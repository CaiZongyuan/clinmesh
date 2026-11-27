import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createOperationCatalog } from '../../../server/operation-catalog';
import { createApp } from '../../../server/app';
import { builtinModules } from '../../../server/builtin-modules';
import { createWorkspaceApp } from '../../../server/workspace';
import { createNodeSqliteStore } from '../../store';
import type { OperationCatalog } from '../../platform';
import { describeOperation, inputValidator, type OperationDescription } from '../index';

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

it('applies input-only uniqueness, reserved keys and nonzero amounts identically offline and on the server', () => {
  const { catalog } = createOperationCatalog(builtinModules);
  const id = '0191abcd-1111-7000-8000-000000000001';
  const second = '0191abcd-1111-7000-8000-000000000002';
  const write = { id, epoch: id, expectedVersion: 0, idempotencyKey: 'normal' };
  const quote = { serviceId: id, catalogVersion: '1', unitPriceMinor: 1, currencyCode: 'USD', currencyExponent: 2 };
  const cases: [string, object, object][] = [
    ['encounter.start', write, { idempotencyKey: ' patient-reply:review' }],
    ['command.receipt.get', { epoch: id, idempotencyKey: 'normal' }, { idempotencyKey: 'patient-reply:review' }],
    ['lab.save-draft', { ...write, serviceIds: [id, second] }, { serviceIds: [id, id] }],
    ['lab.issue', { ...write, items: [quote] }, { items: [quote, { ...quote, unitPriceMinor: 2 }] }],
    ['payment.preview', { ...write, chargeIds: [id] }, { chargeIds: [id, id] }],
    ['payment.preview', { ...write, chargeIds: [id], tenders: [{ method: 'cash', amountMinor: 1 }] }, { tenders: [{ method: 'cash', amountMinor: 1 }, { method: 'cash', amountMinor: 2 }] }],
    ['benefit.preview', { ...write, planId: 'example', chargeIds: [id] }, { chargeIds: [id, id] }],
    ['ward.order.verify', { ...write, orderIds: [id] }, { orderIds: [id, id] }],
    ['ward.task.administer', { ...write, taskIds: [id] }, { taskIds: [id, id] }],
    ['ward.surgery.execute', { ...write, requestId: id, materials: [{ itemId: id, quantity: 1 }] }, { materials: [{ itemId: id, quantity: 1 }, { itemId: id, quantity: 2 }] }],
    ['inpatient.correction', { ...write, chargeId: id, amountMinor: -1, reason: 'Duplicate entry' }, { amountMinor: 0 }],
  ];
  for (const [operation, valid, changes] of cases) {
    const generated = offline.find(entry => entry.id === operation)!;
    const server = catalog.require(operation).contract.inputSchema;
    for (const validator of [inputValidator(generated), server]) {
      expect(validator.safeParse(valid).success, operation).toBe(true);
      expect(validator.safeParse({ ...valid, ...changes }).success, operation).toBe(false);
    }
  }
});

it('normalizes only the declared text before checking bounds, patterns and nested fields', () => {
  const { catalog } = createOperationCatalog(builtinModules);
  const id = '0191abcd-1111-7000-8000-000000000001';
  const write = { id, epoch: id, expectedVersion: 0, idempotencyKey: 'normal' };
  const override = (note: string) => ({ clinicalOverride: { note, reasonCode: 'specialist-judgment', ruleCodes: [' rule '] } });
  const diagnoses = (code: string) => ({ diagnoses: [{ codeSystem: 'urn:teaching', code, primary: true }] });
  const question = 'a'.repeat(8000);
  const cases: [string, object, object | false][] = [
    ['consultation.question', { channel: 'text', content: `  ${question}\t` }, { content: question }],
    ['consultation.question', { channel: 'text', content: '\t   ' }, false],
    ['consultation.question', { channel: 'text', content: question + 'b' }, false],
    ['prescription.no-medication', { reason: '   ' }, false],
    ['prescription.no-medication', { reason: '\tReason  ' }, { reason: 'Reason' }],
    ['encounter.complete', override(' 	 '), false],
    ['encounter.complete', override(' abc  '), false],
    ['encounter.complete', override('  note\t'), override('note')],
    ['diagnosis.draft', diagnoses('  J18.9\t'), diagnoses('J18.9')],
    ['diagnosis.draft', diagnoses('   '), false],
    ['prescription.withdraw', { reason: ' why ' }, { reason: 'why' }],
    ['prescription.withdraw', { reason: 'why', noMedicationReason: '  no  ' }, { noMedicationReason: 'no' }],
    ['prescription.withdraw', { reason: 'why', noMedicationReason: '   ' }, false],
    ['record.draft', { expectedDraftVersion: 0, fields: { concern: ' \t  ' } }, { fields: { concern: ' \t  ' } }],
    ['record.sign', { idempotencyKey: ` ${'k'.repeat(160)} ` }, { idempotencyKey: 'k'.repeat(160) }],
  ];
  for (const [name, fields, expected] of cases) {
    const input = { ...write, ...fields };
    const runtime = catalog.require(name).contract.inputSchema.safeParse(input);
    const projected = inputValidator(offline.find(operation => operation.id === name)!).safeParse(input);
    expect(projected.success, name).toBe(expected !== false);
    expect(runtime.success, name).toBe(projected.success);
    if (expected !== false) {
      expect(projected.data, name).toEqual({ ...input, ...expected });
      expect(runtime.data, name).toEqual(projected.data);
    }
  }
  const workspace = offline.find(operation => operation.id === 'workspace.reset')!;
  const { id: _id, ...withoutTarget } = write;
  expect(inputValidator(workspace).parse({ ...withoutTarget, packId: '  ' }).packId).toBe('  ');
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
