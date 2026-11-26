import { v7 } from 'uuid';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import general from '../../../../data/packs/global-general/pack.json';
import cardiology from '../../../../data/packs/cn-cardiology/pack.json';
import { encounterViewSchema, registerClinicalOperations } from '../../clinical-core';
import { installHospitalDataPack, parseHospitalDataPack, type HospitalDataPack } from '../../data-pack';
import { startEncounter } from '../../patient-visit';
import { ModuleRegistry, OperationCatalog, registerPlatformOperations, type Credential } from '../../platform';
import { createNodeSqliteStore, type StorePort } from '../../store';
import { createLabModule, labViewSchema, type LabBillingPort } from '../index';

const stores: StorePort[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function clinic(configure?: (pack: HospitalDataPack) => void, billing?: LabBillingPort, source: unknown = general, caseKey = 'g02') {
  const pack = structuredClone(parseHospitalDataPack(source));
  configure?.(pack);
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  stores.push(store);
  const workspaceId = v7();
  const id = v7();
  const expiresAt = '2099-01-01T00:00:00Z';
  const credential: Credential = { ticket: { workspaceId, kind: 'visitor', id, expiresAt } };
  const { at, caseId } = await store.withTransaction(tx => {
    const at = installHospitalDataPack(tx, { workspaceId, expectedEpoch: null, virtualTime: '2028-01-01T00:00:00Z' }, pack);
    const doctor = pack.organization.practitionerRoles.find(role => role.capabilities.includes('assess'))!;
    tx.insert(at, 'visitor_sessions', { id, practitioner_role: doctor.id, expires_at: expiresAt, version: 1, revoked: false });
    return { at, caseId: tx.list(at, 'clinical_cases', { case_key: caseKey })[0]!.id };
  });
  const module = createLabModule({ billing });
  const registry = new ModuleRegistry([module]);
  const catalog = new OperationCatalog();
  catalog.contribute(module.id, entries => module.registerOperations!(entries));
  registerClinicalOperations(catalog, registry);
  registerPlatformOperations(catalog, { modules: registry, sign: async () => '' });
  catalog.command({ name: 'encounter.start', path: '/start/:id', method: 'POST', access: {} }, {}, z.object({ encounterId: z.uuidv7() }), context => startEncounter(context));
  const call = (name: string, targetId: string, version = 0, fields: Record<string, unknown> = {}, key = v7()) => catalog.require(name).invoke({
    store, credential, targetId, body: async () => ({ ...fields, expectedVersion: version, idempotencyKey: key, epoch: at.epoch }),
  });
  const newEncounter = async () => z.object({ encounterId: z.uuidv7() }).parse(await call('encounter.start', caseId)).encounterId;
  let encounterId = await newEncounter();
  const view = async () => labViewSchema.parse(await call('lab.read', encounterId));
  const issue = async (...codes: string[]) => {
    const before = await view();
    const serviceIds = codes.map(code => before.services.find(service => service.code === code)!.id);
    await call('lab.save-draft', encounterId, before.draft.version, { serviceIds });
    const { draft } = await view();
    await call('lab.issue', encounterId, draft.version, { items: draft.items });
    return (await view()).orders.filter(order => order.status === 'issued' && serviceIds.includes(order.serviceId));
  };
  const start = async (orderId: string) => {
    await call('lab.accept', orderId, 1);
    await call('lab.start', orderId, 2);
  };
  const role = (version: number, roleId: string) => call('workspace.role', workspaceId, version, { roleId });
  const signRecord = async () => {
    const { template } = encounterViewSchema.parse(await call('encounter.read', encounterId));
    const fields = Object.fromEntries(template.filter(field => field.required).map(field => [field.id, `Synthetic ${field.id}`]));
    await call('record.draft', encounterId, 1, { expectedDraftVersion: 0, fields });
    await call('record.sign', encounterId, 2);
  };
  const confirmDiagnosis = async () => {
    const { code, codeSystem } = pack.catalog.diagnoses[0]!;
    await call('diagnosis.draft', encounterId, 3, { diagnoses: [{ code, codeSystem, primary: true }] });
    await call('diagnosis.confirm', encounterId, 4);
  };
  return { store, at, call, encounterId, view, issue, start, role, signRecord, confirmDiagnosis, async revisit() { encounterId = await newEncounter(); } };
}

it('keeps a saved draft separate from formal orders and isolates catalog conflicts in one confirmation', async () => {
  const { call, encounterId, view } = await clinic();
  const services = (await view()).services;
  const ecg = services.find(service => service.code === 'ecg12')!;
  const troponin = services.find(service => service.code === 'hs-tni')!;
  await call('lab.save-draft', encounterId, 0, { serviceIds: [ecg.id, troponin.id] });
  expect((await view()).orders).toEqual([]);
  const items = (await view()).draft.items;
  const key = v7();
  const issue = () => call('lab.issue', encounterId, 1, { items: items.map(item => item.serviceId === ecg.id ? { ...item, unitPriceMinor: 1 } : item) }, key);
  const receipt = await issue();
  expect(await issue()).toEqual(receipt);
  expect(receipt).toMatchObject({ results: [{ serviceId: ecg.id, error: 'CATALOG_CONFLICT' }, { serviceId: troponin.id, orderId: expect.any(String) }] });
  const saved = await view();
  expect(saved.draft.items).toMatchObject([{ serviceId: ecg.id }]);
  expect(saved.orders).toMatchObject([{ serviceId: troponin.id, status: 'issued' }]);
  expect(JSON.stringify(saved)).not.toMatch(/Decimal transcription|hiddenHistory|follow-up|matchKey/);
});

it('publishes only released versions, retains old acknowledgements and rechecks completion in the write transaction', async () => {
  const { call, encounterId, view, issue, start, role, signRecord, confirmDiagnosis } = await clinic();
  const [order] = await issue('hs-tni');
  const orderId = order!.id;
  await expect(call('lab.start', orderId, 1)).rejects.toThrow('INVALID_ORDER_STATE');
  await start(orderId);
  await call('lab.report-now', orderId, 3);
  const first = (await view()).orders[0]!.reports[0]!;
  expect(first).toMatchObject({ version: 1, acknowledged: null, observations: [{ value: 12, unit: 'ng/L', interpretation: 'normal', critical: false }] });
  expect(JSON.stringify(await view())).not.toContain('Decimal transcription');
  await expect(call('lab.amend', first.id, 4, { reportVersion: 1 })).rejects.toThrow('ROLE_FORBIDDEN');
  await call('lab.acknowledge', first.id, 4, { reportVersion: 1 });
  const [repeat] = await issue('hs-tni');
  await role(1, 'coordinator');
  await call('lab.amend', first.id, 5, { reportVersion: 1 });
  const revised = (await view()).orders[0]!;
  const latest = revised.reports[1]!;
  expect((await view()).orders.find(order => order.id === repeat!.id)?.status).toBe('issued');
  expect(revised.status).toBe('reported');
  expect(revised.reports[0]).toMatchObject({ ...first, acknowledged: { role: 'family-clinician' } });
  expect(latest).toMatchObject({ previousId: first.id, version: 2, acknowledged: null, observations: [{ value: 120, interpretation: 'high', critical: true }] });
  await role(2, 'family-clinician');
  await expect(call('lab.acknowledge', first.id, 6, { reportVersion: 1 })).rejects.toThrow('REPORT_SUPERSEDED');
  await expect(call('lab.acknowledge', latest.id, 6, { reportVersion: 1 })).rejects.toThrow('VERSION_CONFLICT');
  await signRecord();
  await confirmDiagnosis();
  await expect(call('encounter.complete', encounterId, 5)).rejects.toThrow('COMPLETION_BLOCKED');
  await call('lab.acknowledge', latest.id, 6, { reportVersion: 2 });
  await expect(call('encounter.complete', encounterId, 5)).rejects.toThrow('COMPLETION_BLOCKED');
  await call('lab.cancel', repeat!.id, 1);
  await expect(call('encounter.complete', encounterId, 5)).resolves.toEqual({ version: 6 });
});

it('applies follow-up > repeat > inpatient > initial to server-known encounters and converts authored mass concentrations', async () => {
  const host = await clinic(pack => {
    const patient = pack.cases.find(item => item.caseId === 'g02')!;
    patient.encounterClass = 'inpatient';
    const template = patient.caseTruth.results.find(result => result.service.code === 'hs-tni')!;
    for (const [stage, value] of [['inpatient', 0.12], ['repeat', 0.09], ['follow-up', 0.007]] as const) {
      patient.caseTruth.results.push({ ...template, stage, observations: [{ ...template.observations[0]!, value, unit: 'ng/mL' }] });
    }
  });
  async function measure(expected: number) {
    const [order] = await host.issue('hs-tni');
    await host.start(order!.id);
    await host.call('lab.report-now', order!.id, 3);
    const report = (await host.view()).orders.find(item => item.id === order!.id)!.reports[0]!;
    expect(report.observations[0]).toMatchObject({ value: expected, unit: 'ng/L', critical: expected === 120 });
    await host.call('lab.acknowledge', report.id, 4, { reportVersion: 1 });
  }
  await measure(120);
  await measure(90);
  await host.signRecord(); await host.confirmDiagnosis();
  await host.call('encounter.complete', host.encounterId, 5);
  await host.revisit();
  await measure(7); await measure(7);
});

it('applies signed-note and diagnosis policies before issuing ECG and TTE, then publishes at virtual turnaround', async () => {
  const host = await clinic(undefined, undefined, cardiology, 'c01');
  const original = await host.view();
  expect(original.services.some(service => service.code === 'cag')).toBe(false);
  const serviceIds = original.services.filter(service => ['ecg', 'tte'].includes(service.code)).map(service => service.id);
  await host.call('lab.save-draft', host.encounterId, 0, { serviceIds });
  const draft = (await host.view()).draft;
  const issue = () => host.call('lab.issue', host.encounterId, draft.version, { items: draft.items });
  await expect(issue()).rejects.toThrow('CLINICAL_DOCUMENT_UNSIGNED');
  await host.signRecord();
  await expect(issue()).rejects.toThrow('DIAGNOSIS_UNCONFIRMED');
  await host.confirmDiagnosis(); await issue();
  for (const order of (await host.view()).orders) await host.start(order.id);
  await host.role(1, 'hospital-admin');
  await host.call('workspace.advance-time', host.at.workspaceId, 0, { to: '2028-01-01T00:29:59Z' });
  expect((await host.view()).orders.every(order => order.status === 'in-progress' && !order.reports.length)).toBe(true);
  await host.call('workspace.advance-time', host.at.workspaceId, 1, { to: '2028-01-01T01:00:00Z' });
  const reports = (await host.view()).orders.flatMap(order => order.reports);
  expect(reports).toHaveLength(2);
  expect(reports.every(report => report.signedAt === '2028-01-01T00:30:00.000Z')).toBe(true);
  expect(reports.map(report => report.observations)).toContainEqual([expect.objectContaining({ code: 'LVEF', value: 56, interpretation: 'normal' })]);
  expect(reports.some(report => report.observations.length === 0 && report.summary.en.length > 5)).toBe(true);
});

it.each(['missing', 'missing unit', 'unsupported unit', 'qualitative instead of number', 'partial result', 'explicit baseline', 'normal follow-up baseline', 'abnormal follow-up baseline', 'conflicting baseline'] as const)('handles %s without disclosing unused truth or synthesizing a finding', async scenario => {
  const host = await clinic(pack => {
    const patient = pack.cases.find(item => item.caseId === 'g02')!;
    const initial = patient.caseTruth.results.find(result => result.service.code === 'hs-tni')!;
    patient.caseTruth.results = [];
    if (scenario === 'missing unit') patient.caseTruth.results.push({ ...initial, observations: [{ analyte: initial.observations[0]!.analyte, value: 12 }] });
    if (scenario === 'qualitative instead of number') patient.caseTruth.results.push({ ...initial, observations: [{ ...initial.observations[0]!, value: 'positive', interpretation: 'abnormal' }] });
    if (scenario === 'unsupported unit') patient.caseTruth.results.push({ ...initial, observations: [{ ...initial.observations[0]!, unit: 'mmHg' }] });
    if (scenario === 'partial result') patient.caseTruth.results.push({ ...initial, observations: [] });
    if (scenario.includes('baseline') || scenario === 'partial result') patient.caseTruth.normalBaselines = [{ service: initial.service, summary: { en: 'Authored normal', zh: '已编写的正常基线' }, observations: initial.observations }];
    if (scenario.includes('follow-up')) patient.caseTruth.results.push({ ...initial, stage: 'follow-up', observations: [{ ...initial.observations[0]!, value: scenario === 'normal follow-up baseline' ? 10 : 120 }] });
    if (scenario === 'conflicting baseline') {
      const companion = { ...pack.catalog.services.find(item => item.code === 'hs-tni')!, code: 'same-analyte-panel' };
      pack.catalog.services.push(companion);
      patient.caseTruth.results.push({ ...initial, service: { code: companion.code, codeSystem: companion.codeSystem }, observations: [{ ...initial.observations[0]!, value: 257 }] });
    }
  });
  const [order] = await host.issue('hs-tni');
  await host.start(order!.id); await host.call('lab.report-now', order!.id, 3);
  const published = (await host.view()).orders[0]!;
  if (scenario === 'explicit baseline' || scenario === 'normal follow-up baseline') expect(published.reports[0]).toMatchObject({ summary: { en: 'Authored normal' }, observations: [{ value: 12, interpretation: 'normal' }] });
  else {
    expect(published).toMatchObject({ status: 'generation-failed', reports: [] });
    await host.call('lab.cancel', order!.id, 4);
    expect(await host.call('encounter.completion', host.encounterId)).toMatchObject({ checks: expect.arrayContaining([{ id: 'report-acknowledgement', passed: true, label: expect.any(Object) }]) });
  }
});

it('serializes two confirmations and prevents a second ongoing request while retaining editable drafts', async () => {
  const host = await clinic();
  const id = (await host.view()).services[0]!.id;
  await host.call('lab.save-draft', host.encounterId, 0, { serviceIds: [id] });
  let draft = (await host.view()).draft;
  const issue = () => host.call('lab.issue', host.encounterId, draft.version, { items: draft.items });
  const receipts = await Promise.allSettled([issue(), issue()]);
  expect(receipts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect((await host.view()).orders).toHaveLength(1);
  await host.call('lab.save-draft', host.encounterId, 2, { serviceIds: [id] });
  draft = (await host.view()).draft;
  expect(await issue()).toMatchObject({ results: [{ serviceId: id, error: 'ACTIVE_ORDER_EXISTS' }] });
  await host.call('lab.save-draft', host.encounterId, draft.version, { serviceIds: [] });
  expect((await host.view()).draft.items).toEqual([]);
});

it('removes operations, the clock hook and report gate from a disabled Hospital Data Pack', async () => {
  const host = await clinic(pack => { pack.manifest.enabledModules = []; });
  await expect(host.view()).rejects.toThrow('MODULE_DISABLED');
  expect(JSON.stringify(await host.call('encounter.completion', host.encounterId))).not.toContain('report-acknowledgement');
});

it.each(['prepaid', 'postpaid', 'free', 'uninstalled'] as const)('binds %s billing to the signed source and reads current funds at acceptance', async policy => {
  let released = policy !== 'prepaid';
  const frozen: Parameters<LabBillingPort['freezeCharge']>[2][] = [];
  const billing: LabBillingPort = {
    freezeCharge(tx, at, row) {
      expect(tx.get(at, 'clinical_orders', row.orderId)).toMatchObject({ encounter_id: row.encounterId, catalog_item_id: row.catalogItemId, status: 'issued' });
      frozen.push(row);
      if (policy === 'free') return null;
      const id = v7();
      tx.insert(at, 'charge_items', { id, encounter_id: row.encounterId, order_id: row.orderId, description: 'Test charge', amount_minor: row.unitPriceMinor, currency_code: row.currencyCode, currency_exponent: row.currencyExponent, virtual_at: row.virtualAt, recorded_at: row.recordedAt });
      return id;
    },
    readOrderFunds(reader, at, orderId) {
      expect(reader.list(at, 'charge_items', { order_id: orderId })).toHaveLength(policy === 'free' ? 0 : 1);
      return { released, locked: released && policy === 'prepaid' };
    },
  };
  const host = await clinic(pack => {
    pack.manifest.policies.outpatientInvestigationBillingPolicy = policy === 'uninstalled' ? 'prepaid' : policy;
    if (policy === 'prepaid') pack.manifest.currency.code = 'CNY';
    if (policy === 'uninstalled') pack.manifest.enabledModules = ['mod-lab'];
  }, billing);
  const service = (await host.view()).services.find(service => service.code === 'hs-tni')!;
  await host.call('lab.save-draft', host.encounterId, 0, { serviceIds: [service.id] });
  expect(frozen).toEqual([]);
  const { draft } = await host.view();
  const key = v7();
  const issue = () => host.call('lab.issue', host.encounterId, draft.version, { items: draft.items }, key);
  const receipt = await issue();
  expect(await issue()).toEqual(receipt);
  const order = (await host.view()).orders[0]!;
  const currencyCode = policy === 'prepaid' ? 'CNY' : 'USD';
  if (policy === 'uninstalled') expect(frozen).toEqual([]);
  else expect(frozen).toMatchObject([{ orderId: order.id, encounterId: host.encounterId, catalogItemId: service.id, catalogVersion: service.catalogVersion, quantity: 1, unitPriceMinor: 2200, currencyCode, currencyExponent: 2 }]);
  if (policy === 'prepaid') {
    await expect(host.call('lab.accept', order.id, 1)).rejects.toThrow('PAYMENT_REQUIRED');
    expect((await host.view()).orders[0]!.status).toBe('issued');
    released = true;
  }
  expect(await host.call('lab.accept', order.id, 1)).toEqual({ version: 2, status: 'accepted' });
  if (policy === 'prepaid') await expect(host.call('lab.cancel', order.id, 2)).rejects.toThrow('CHARGE_LOCKED');
});

it('rolls back a clinical issue and its partially frozen charge on a billing write failure', async () => {
  const host = await clinic(undefined, {
    freezeCharge(tx, at, row) {
      tx.insert(at, 'charge_items', { id: v7(), encounter_id: row.encounterId, order_id: row.orderId, description: 'Test failure', amount_minor: row.unitPriceMinor, currency_code: row.currencyCode, currency_exponent: row.currencyExponent, virtual_at: row.virtualAt, recorded_at: row.recordedAt });
      throw Error('BILLING_FAILED');
    },
    readOrderFunds() { throw Error('Unexpected funds query'); },
  });
  await expect(host.issue('hs-tni')).rejects.toThrow('BILLING_FAILED');
  expect(await host.view()).toMatchObject({ draft: { version: 1, items: [expect.any(Object)] }, orders: [] });
  expect(await host.store.read(reader => reader.list(host.at, 'charge_items'))).toEqual([]);
});

it.each([
  ['6690-2', '10*3/uL', '10*9/L', 18, 18], ['718-7', 'g/dL', 'g/L', 13.5, 135],
  ['2339-0', 'mg/dL', 'mmol/L', 180, 9.99135], ['14682-9', 'mg/dL', 'µmol/L', 2, 176.8],
] as const)('converts coded %s from %s to %s', async (code, unit, target, value, expected) => {
  const host = await clinic(pack => {
    const service = pack.catalog.services.find(item => item.code === 'hs-tni')!;
    const leaf = service.analytes[0]!;
    leaf.code = code; leaf.unit = target;
    for (const patient of pack.cases) for (const result of patient.caseTruth.results.filter(item => item.service.code === service.code)) {
      result.observations = [{ analyte: { codeSystem: 'http://loinc.org', code }, value, unit }];
    }
  });
  const [order] = await host.issue('hs-tni');
  await host.start(order!.id); await host.call('lab.report-now', order!.id, 3);
  expect((await host.view()).orders[0]!.reports[0]!.observations[0]).toMatchObject({ value: expected, unit: target });
});
