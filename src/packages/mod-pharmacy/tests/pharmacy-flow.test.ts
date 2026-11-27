import { expect, it } from 'vitest';
import { createTestHarness, experimental_readRawConfig } from 'wrangler';
import { z } from 'zod';
import { teachingGate, withNodeWorkspace } from '../../../../scripts/testing/node-workspace';
import { openPharmacySession, type PharmacyHttp } from '../../../../scripts/testing/pharmacy-session';
import { createApp } from '../../../server/app';
import { createWorkspaceApp } from '../../../server/workspace';
import { createNodeSqliteStore } from '../../store';
import { createPharmacyModule, dispenseQueueSchema, prescribingViewSchema, type PharmacyBillingPort } from '../index';

const dose = { codeSystem: 'urn:clinmesh:general:drug', code: 'doxycycline', dose: 100, routeCode: 'PO', timesPerDay: 2, days: 5, quantity: 10 };
const queue = '/api/his/pharmacy/queue';
const receipt = z.object({ prescriptionId: z.uuidv7() });

async function pharmacyFlow(fetchApi: PharmacyHttp) {
  const { command, role, get, start, account, money, collect, workspace } = await openPharmacySession(fetchApi);
  const cap = await start('Avery Reed', 'J18.9');
  const sign = (version: number, lines: typeof dose[], extra: object = {}) => command(`${cap}/prescriptions`, version, { lines, ...extra });
  const refused = async (request: ReturnType<typeof command>, code: string) => { const response = await request; expect([response.status, await response.json()]).toEqual([409, { code }]); };
  await refused(sign(5, [{ ...dose, code: 'amoxicillin', dose: 500 }], { override: { reason: 'synthetic override' } }), 'MEDICATION_ALLERGY_CONFLICT');
  await refused(sign(5, [dose, { ...dose, codeSystem: 'urn:clinmesh:general:community-drug', code: 'doxy-100' }]), 'PRESCRIPTION_MIXED_CATALOG_SOURCES');
  await refused(sign(5, [{ ...dose, routeCode: 'PR' }]), 'PRESCRIPTION_ROUTE_NOT_ALLOWED');
  const signed = receipt.parse(await (await sign(5, [dose])).json());
  const firstOrder = prescribingViewSchema.parse(await get(`${cap}/prescriptions`)).prescriptions[0]!.lines[0]!.orderId;
  await refused(command(`${cap}/no-medication`, 6, { reason: 'Review' }), 'MEDICATION_DECISION_CONFLICT');
  expect((await command(`${cap}/complete`, 6)).status).toBe(200);
  await role('pharmacist');
  const dispense = () => command(`/api/his/prescriptions/${signed.prescriptionId}/dispense`, 1);
  expect(await get(queue)).toEqual([]);
  await refused(dispense(), 'PRESCRIPTION_PAYMENT_REQUIRED');
  await role('cashier');
  const frozen = (await account(cap)).charges.find(item => item.orderId === firstOrder)!;
  expect(frozen).toMatchObject({ amountMinor: 750, quantity: 10, unitPriceMinor: 75, catalogVersion: workspace.manifest.version });
  const pending = await collect(cap, firstOrder, 'delayed-approval');
  expect(pending.status).toBe('unknown');
  await role('family-clinician');
  await refused(command(`/api/his/prescriptions/${signed.prescriptionId}/withdraw`, 1, { reason: 'Review', noMedicationReason: 'Reassessed' }), 'PRESCRIPTION_FUNDS_LOCKED');
  await role('pharmacist');
  expect(await get(queue)).toEqual([]);
  await refused(dispense(), 'PRESCRIPTION_PAYMENT_REQUIRED');
  await role('cashier');
  expect(await money(cap, 'payment.recover', { paymentId: pending.paymentId, paymentVersion: 1 })).toMatchObject({ status: 'succeeded' });
  expect((await account(cap)).charges.find(item => item.id === frozen.id)).toMatchObject({ outstandingMinor: 0, netPaidMinor: 750 });
  await role('pharmacist');
  expect(await get(queue)).toMatchObject([{ prescriptionId: signed.prescriptionId, allergies: { status: 'confirmed', items: [{ groupCode: 'penicillin' }] }, lines: [{ quantity: 10, lots: [{ lotNumber: 'GEN-A', available: 6 }, { lotNumber: 'GEN-B', available: 60 }] }] }]);
  const attempts = await Promise.all([dispense(), dispense()]);
  expect(attempts.map(response => response.status).sort()).toEqual([200, 409]);
  expect(await attempts.find(response => response.status === 200)!.json()).toMatchObject({ allocations: [{ lotNumber: 'GEN-A', quantity: 6 }, { lotNumber: 'GEN-B', quantity: 4 }] });
  expect(await get(queue)).toEqual([]);
  await role('family-clinician');
  await refused(command(`/api/his/prescriptions/${signed.prescriptionId}/withdraw`, 2, { reason: 'Review' }), 'PRESCRIPTION_DISPENSED');
  const repeat = await start('Jordan Vale', 'J18.9');
  const second = receipt.parse(await (await command(`${repeat}/prescriptions`, 5, { lines: [dose] })).json());
  const secondOrder = prescribingViewSchema.parse(await get(`${repeat}/prescriptions`)).prescriptions[0]!.lines[0]!.orderId;
  expect((await command(`${repeat}/complete`, 6)).status).toBe(200);
  await role('cashier');
  const waived = (await account(repeat)).charges.find(item => item.orderId === secondOrder)!;
  await money(repeat, 'charge.adjust', { chargeId: waived.id, amountMinor: 750, reason: 'Cancel the teaching supply charge' });
  await role('pharmacist');
  expect(await get(queue)).toMatchObject([{ lines: [{ lots: [{ lotNumber: 'GEN-B', available: 56 }] }] }]);
  await role('family-clinician');
  const withdrawal = `/api/his/prescriptions/${second.prescriptionId}/withdraw`;
  await refused(command(withdrawal, 1, { reason: 'Reassessed' }), 'REPLACEMENT_DECISION_REQUIRED');
  expect((await command(withdrawal, 1, { reason: 'Reassessed', noMedicationReason: 'Supportive care after reassessment' })).status).toBe(200);
  expect(await get(`${repeat}/prescriptions`)).toMatchObject({ prescriptions: [{ status: 'withdrawn', version: 2, withdrawalReason: 'Reassessed' }], noMedication: { reason: 'Supportive care after reassessment' } });
  expect(await get(repeat)).toMatchObject({ status: 'completed', completion: { ready: true }, recordRevisions: [{ revision: 1 }] });
  await role('pharmacist');
  expect(await get(queue)).toEqual([]);
  await refused(command(`/api/his/prescriptions/${second.prescriptionId}/dispense`, 2), 'PRESCRIPTION_WITHDRAWN');
  await role('cashier');
  expect((await account(repeat)).charges.find(charge => charge.id === waived.id)).toMatchObject({ cancelled: true, netMinor: 0, adjustments: [{ amountMinor: -750 }] });
  await role('family-clinician');
  const viral = await start('Riley Dale', 'J06.9');
  expect(await get(`${viral}/completion`)).toMatchObject({ ready: false });
  expect((await command(`${viral}/no-medication`, 5, { reason: 'Symptomatic care' })).status).toBe(200);
  await refused(command(`${viral}/prescriptions`, 6, { lines: [dose] }), 'MEDICATION_DECISION_CONFLICT');
  expect(await get(`${viral}/prescriptions`)).toMatchObject({ prescriptions: [], noMedication: { reason: 'Symptomatic care' } });
  expect((await command(`${viral}/complete`, 6)).status).toBe(200);
}

it('signs, withdraws, closes and dispenses selected outpatient treatment over native Node HTTP', async () => {
  await withNodeWorkspace(origin => pharmacyFlow((path, init) => fetch(origin + path, init)));
}, 45000);

it('serves the same pharmacy workflow on the deployed Worker entry and SQLite Durable Object', async () => {
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.jsonc' });
  const server = createTestHarness({ workers: [{ config: { ...rawConfig, assets: undefined, vars: teachingGate } }] });
  try { await server.listen(); const worker = server.getWorker(); await pharmacyFlow((path, init) => worker.fetch(path, init)); }
  finally { await server.close(); }
}, 45000);

it('freezes only hospital orders, rereads funding on withdrawal and dispense, and leaves external supply outside the ledger', async () => {
  const store = createNodeSqliteStore({ dbPath: ':memory:' });
  const charges: Parameters<PharmacyBillingPort['freezeCharge']>[2][] = [];
  let funds: ReturnType<PharmacyBillingPort['readOrderFunds']> = { state: 'unpaid', locked: false };
  let failFunding = true;
  const billing: PharmacyBillingPort = { freezeCharge(tx, at, source) {
    expect(tx.get(at, 'clinical_orders', source.orderId)?.catalog_item_id).toBe(source.catalogItemId);
    if (failFunding) throw Error('Synthetic billing failure');
    charges.push(source); return source.orderId;
  }, readOrderFunds: () => funds };
  const settings = { ...teachingGate, loadSigningSecret: () => store.visitorSigningSecret() };
  const modules = [createPharmacyModule(billing)];
  const workspace = createWorkspaceApp(store, settings, modules);
  const app = createApp('node', settings, (incoming, credential, entering) => workspace.fetch(incoming, { credential, entering }), modules);
  try {
    const session = await openPharmacySession((path, init) => Promise.resolve(app.request(path, init)));
    const { start, role, applied, command, get } = session;
    const cap = await start('Avery Reed', 'J18.9');
    const sign = (line: typeof dose, key = crypto.randomUUID()) => command(`${cap}/prescriptions`, 5, { lines: [line] }, 'POST', key);
    expect((await sign(dose)).status).toBe(500);
    expect(await get(`${cap}/prescriptions`)).toMatchObject({ prescriptions: [] });
    failFunding = false;
    const key = crypto.randomUUID();
    const signed = await applied(sign(dose, key));
    expect(await applied(sign(dose, key))).toEqual(signed);
    expect(charges).toMatchObject([{ catalogVersion: session.workspace.manifest.version, quantity: 10, unitPriceMinor: 75, currencyCode: 'USD', currencyExponent: 2 }]);
    const rx = `/api/his/prescriptions/${receipt.parse(signed).prescriptionId}`;
    await applied(command(`${cap}/complete`, 6));
    await role('pharmacist');
    expect(await get(queue)).toEqual([]);
    funds = { state: 'settled', locked: false };
    const reviewed = dispenseQueueSchema.parse(await get(queue))[0]!;
    funds = { state: 'unknown', locked: true };
    expect(await (await command(`${rx}/dispense`, 1)).json()).toEqual({ code: 'PRESCRIPTION_PAYMENT_REQUIRED' });
    await role('family-clinician');
    for (const state of ['partial', 'unknown', 'settled'] as const) {
      funds = { state, locked: state === 'settled' };
      expect(await (await command(`${rx}/withdraw`, 1, { reason: 'Requested', noMedicationReason: 'Reassessed' })).json()).toEqual({ code: 'PRESCRIPTION_FUNDS_LOCKED' });
    }
    funds = { state: 'settled', locked: false };
    await role('pharmacist');
    const { orderId, lots } = reviewed.lines[0]!;
    const debit = (first: number, second: number) => command(`${rx}/dispense`, 1, { lots: [{ orderId, lotId: lots[0]!.lotId, quantity: first }, { orderId, lotId: lots[1]!.lotId, quantity: second }] });
    expect(await (await debit(7, 3)).json()).toEqual({ code: 'PHARMACY_INSUFFICIENT_STOCK' });
    expect(await (await debit(1, 4)).json()).toEqual({ code: 'PHARMACY_LOT_MISMATCH' });
    expect(await get(queue)).toMatchObject([{ lines: [{ lots: [{ available: 6 }, { available: 60 }] }] }]);
    expect(await applied(debit(1, 9))).toMatchObject({ allocations: [{ lotNumber: 'GEN-A', quantity: 1 }, { lotNumber: 'GEN-B', quantity: 9 }] });
    await role('family-clinician');
    const external = await start('Jordan Vale', 'J18.9');
    const result = receipt.parse(await applied(command(`${external}/prescriptions`, 5, { lines: [{ ...dose, codeSystem: 'urn:clinmesh:general:community-drug', code: 'doxy-100' }] })));
    await applied(command(`${external}/complete`, 6));
    await role('pharmacist');
    expect(await get(queue)).toEqual([]);
    expect(await (await command(`/api/his/prescriptions/${result.prescriptionId}/dispense`, 1)).json()).toEqual({ code: 'PRESCRIPTION_EXTERNAL' });
    expect(charges).toHaveLength(1);
  } finally { await store.close(); }
});

it('allows only one of two prescriptions competing for the same stock and rolls the losing multi-lot allocation back', async () => {
  await withNodeWorkspace(async origin => {
    const { start, role, command, applied, get, collect } = await openPharmacySession((path, init) => fetch(origin + path, init));
    for (const patient of ['Avery Reed', 'Jordan Vale']) {
      const path = await start(patient, 'J18.9');
      await applied(command(`${path}/prescriptions`, 5, { lines: [{ ...dose, days: 30, quantity: 40 }] }));
      await applied(command(`${path}/complete`, 6));
      const order = prescribingViewSchema.parse(await get(`${path}/prescriptions`)).prescriptions[0]!.lines[0]!.orderId;
      await role('cashier');
      await collect(path, order);
      await role('family-clinician');
    }
    await role('pharmacist');
    const waiting = dispenseQueueSchema.parse(await get(queue));
    const outcomes = await Promise.all(waiting.map(rx => command(`/api/his/prescriptions/${rx.prescriptionId}/dispense`, 1)));
    expect(outcomes.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await outcomes.find(response => response.status === 409)!.json()).toEqual({ code: 'PHARMACY_INSUFFICIENT_STOCK' });
    expect(await get(queue)).toMatchObject([{ lines: [{ lots: [{ lotNumber: 'GEN-B', available: 26 }] }] }]);
  });
}, 45000);
