import { expect, it } from 'vitest';
import { v7 } from 'uuid';
import { z } from 'zod';
import { cdsWorkspace } from '../../../server/testing/cds-workspace';
import { createNodeSqliteStore } from '../../store';
import { createApp } from '../../../server/app';
import { createWorkspaceApp } from '../../../server/workspace';
import { fhirModule } from '../index';

it('advertises only the eleven R5 read surfaces and refuses writes and unknown search parameters', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  try {
    const settings = { localOpen: true, loadSigningSecret: () => store.visitorSigningSecret() };
    const workspace = createWorkspaceApp(store, settings, [fhirModule]);
    const app = createApp('node', settings, (request, credential, entering) => workspace.fetch(request, { credential, entering }), [fhirModule]);
    const entered = await app.request('/api/auth/visitor/enter', { method: 'POST', body: '{}' });
    const headers = { cookie: entered.headers.get('set-cookie')!.split(';')[0]! };
    const get = (suffix: string, method = 'GET') => app.request(`/fhir/R5/${suffix}`, { headers, method });
    const metadata = await get('metadata');
    expect(metadata.headers.get('content-type')).toContain('application/fhir+json');
    expect(await metadata.json()).toMatchObject({ resourceType: 'CapabilityStatement', fhirVersion: '5.0.0', rest: [{ resource: expect.arrayContaining([expect.objectContaining({ type: 'Patient' })]) }] });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await get('Patient/example', method);
      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({ resourceType: 'OperationOutcome' });
    }
  } finally { await store.close(); }
});

const projected = z.object({ id: z.string(), resourceType: z.string(), meta: z.object({ versionId: z.string(), lastUpdated: z.iso.datetime() }) }).passthrough();
const bundle = z.object({ type: z.string(), total: z.int(), entry: z.array(z.object({ resource: projected })).default([]) });

it('resolves every declared type, instance and version from formal facts without exposing unissued results or private case data', async () => {
  const host = await cdsWorkspace();
  try {
    const path = await host.start('Avery Reed', 'J18.9');
    const encounterId = path.split('/').at(-1)!;
    const patient = bundle.parse(await host.get('/fhir/R5/Patient')).entry[0]!.resource;
    const get = (path: string) => host.fetchApi(`/fhir/R5/${path}`);
    expect(bundle.parse(await host.get('/fhir/R5/DiagnosticReport')).total).toBe(0);
    expect((await get('Patient?private=case-truth')).status).toBe(400);
    expect((await get('AuditEvent')).status).toBe(403);
    expect((await get('CaseTruth')).status).toBe(404);
    expect((await get('Observation?patient=Encounter/abc')).status).toBe(400);
    const versionOne = await (await get(`Encounter/${encounterId}/_history/1`)).json();
    expect(versionOne).toMatchObject({ id: encounterId, status: 'in-progress', meta: { versionId: '1' } });
    const times = { virtual_at: host.now, recorded_at: host.now };
    await host.store.withTransaction(tx => {
      const at = host.at;
      const service = tx.list(at, 'catalog_items', { kind: 'services', code: 'hs-tni' })[0]!;
      const drug = tx.list(at, 'catalog_items', { kind: 'medications', code: 'doxycycline' })[0]!;
      const request = v7(), lab = v7(), drugOrder = v7(), rx = v7(), line = v7(), movement = v7();
      tx.insert(at, 'clinical_orders', { id: lab, encounter_id: encounterId, catalog_item_id: service.id, kind: 'lab', status: 'reported', version: 1, ...times });
      let prior: string | null = null;
      for (const [index, value] of [44, 51].entries()) {
        const id = v7();
        tx.insert(at, 'diagnostic_reports', { id, order_id: lab, revision: index + 1, previous_revision_id: prior, signed_by: 'lab', ...times, findings: { summary: { en: 'Signed', zh: '已签发' }, observations: [{ codeSystem: 'http://loinc.org', code: '89579-7', display: { en: 'Troponin', zh: '肌钙蛋白' }, unit: 'ng/L', value, interpretation: 'high', critical: false }] } });
        prior = id;
      }
      tx.insert(at, 'clinical_orders', { id: drugOrder, encounter_id: encounterId, catalog_item_id: drug.id, kind: 'medication', status: 'issued', version: 1, ...times });
      tx.insert(at, 'prescriptions', { id: rx, encounter_id: encounterId, status: 'dispensed', version: 2, ...times });
      tx.insert(at, 'prescription_orders', { id: line, order_id: drugOrder, prescription_id: rx });
      const lot = tx.list(at, 'inventory_lots', { catalog_item_id: drug.id })[0]!;
      tx.insert(at, 'inventory_movements', { id: movement, lot_id: lot.id, quantity_delta: -1, reason: 'dispensed', ...times });
      tx.insert(at, 'dispenses', { id: v7(), prescription_order_id: line, movement_id: movement, quantity: 1, ...times });
      const procedure = v7(), procedureOrder = v7();
      tx.insert(at, 'catalog_items', { id: procedure, installation_id: service.installation_id, kind: 'procedures', code_system: 'urn:teaching:procedures', code: 'test-procedure', definition: {}, amount_minor: 0, currency_code: 'USD', currency_exponent: 2 });
      tx.insert(at, 'clinical_orders', { id: procedureOrder, encounter_id: encounterId, catalog_item_id: procedure, kind: 'surgery', status: 'completed', version: 1, ...times });
      tx.insert(at, 'surgery_requests', { id: request, order_id: procedureOrder, procedure_item_id: procedure, status: 'completed', version: 1 });
      tx.insert(at, 'surgery_executions', { id: v7(), surgery_request_id: request, outcome: 'completed', ...times });
    });
    await host.role('coordinator');
    const previous = await host.store.exportLogicalSnapshot(host.at.workspaceId);
    const capability = z.object({ rest: z.array(z.object({ resource: z.array(z.object({ type: z.string() })) })) }).parse(await (await get('metadata')).json());
    expect(capability.rest[0]!.resource.map(item => item.type)).toEqual(['Patient', 'Encounter', 'Condition', 'Observation', 'ServiceRequest', 'DiagnosticReport', 'MedicationRequest', 'MedicationDispense', 'Procedure', 'Composition', 'AuditEvent']);
    for (const { type } of capability.rest[0]!.resource) {
      const found = bundle.parse(await (await get(type)).json());
      expect(found.total, type).toBeGreaterThan(0);
      const first = found.entry[0]!.resource;
      expect(first.resourceType).toBe(type);
      expect(await (await get(`${type}/${first.id}`)).json()).toEqual(first);
      expect(await (await get(`${type}/${first.id}/_history/${first.meta.versionId}`)).json()).toEqual(first);
      expect(bundle.parse(await (await get(`${type}/${first.id}/_history`)).json()).entry.map(item => item.resource)).toContainEqual(first);
      expect(bundle.parse(await (await get(`${type}?_id=${first.id}`)).json()).total).toBe(1);
      expect((await get(`${type}?unknown=1`)).status).toBe(400);
    }
    const [report] = bundle.parse(await (await get(`DiagnosticReport?patient=Patient/${patient.id}`)).json()).entry;
    expect(report?.resource.status).toBe('corrected');
    const entry = z.object({ result: z.array(z.object({ reference: z.string() })) }).parse(report?.resource);
    expect(await (await get(entry.result[0]!.reference)).json()).toMatchObject({ valueQuantity: { value: 51 } });
    expect(await (await get(entry.result[0]!.reference.replace(/2$/, '1'))).json()).toMatchObject({ valueQuantity: { value: 44 } });
    expect(bundle.parse(await (await get(`Observation?patient=${v7()}`)).json()).total).toBe(0);
    expect((await get(`DiagnosticReport/${report!.resource.id}/_history/9`)).status).toBe(404);
    expect(await host.store.exportLogicalSnapshot(host.at.workspaceId)).toEqual(previous);
  } finally { await host.store.close(); }
});
