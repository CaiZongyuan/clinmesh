import { z } from 'zod';
import { accountSchema, createBillingModule } from '../../packages/mod-billing';
import { createDrgModule } from '../../packages/mod-drg-cn';
import { sha256, type Credential } from '../../packages/platform';
import { canonicalJson, type StorePort } from '../../packages/store';
import { createWorkspaceApp } from '../workspace';
import legacy from './fixtures/2f49e201-v2.json';

const id = (number: number) => `0192eaf2-cb03-7000-8000-${String(number).padStart(12, '0')}`;
export async function legacyCurrencyConflict(store: StorePort, targetTable: string, code: string, exponent: number) {
  const record = z.record(z.string(), z.json());
  const tables = legacy.tables.map(table => ({ name: table.name, rows: table.rows.map(original => {
    const row = record.parse(original);
    if (table.name === 'data_pack_installations') return { ...row, manifest: { ...record.parse(row.manifest), currency: { code: 'USD', symbol: '$', minorUnitExponent: 2 } } };
    if (!Object.hasOwn(row, 'currency_code')) return row;
    const mismatch = table.name === targetTable;
    return { ...row, amount_minor: mismatch ? 1000 : row.amount_minor!, currency_code: mismatch ? code : 'USD', currency_exponent: mismatch ? exponent : 2 };
  }) }));
  const content = { format: legacy.format, workspaceId: legacy.workspaceId, pi: legacy.pi, tables };
  await store.importLogicalSnapshot({ ...content, sha256: await sha256(canonicalJson(z.json().parse(content))) });
  const billing = createBillingModule();
  const app = createWorkspaceApp(store, { localOpen: true }, [billing]);
  const credential: Credential = { ticket: { kind: 'visitor', workspaceId: legacy.workspaceId, id: id(3), expiresAt: '2099-01-01T00:00:00Z' } };
  const path = `http://localhost/api/his/encounters/${id(7)}/billing`;
  const get = await app.fetch(new Request(path), { credential, entering: false });
  const post = await app.fetch(new Request(`${path}/payment.preview`, { method: 'POST', body: JSON.stringify({ epoch: id(2), expectedVersion: 0, idempotencyKey: crypto.randomUUID(), chargeIds: [id(17)] }) }), { credential, entering: false });
  const after = await store.exportLogicalSnapshot(legacy.workspaceId);
  return { read: { status: get.status, data: await get.json() }, collect: { status: post.status, data: await post.json() }, preserved: after.tables.find(table => table.name === targetTable)!.rows[0], previews: after.tables.find(table => table.name === 'billing_previews')!.rows.length };
}
export async function restoreLegacyBilling(store: StorePort) {
  await store.importLogicalSnapshot(legacy);
  const billing = createBillingModule();
  const app = createWorkspaceApp(store, { localOpen: true }, [billing, createDrgModule(billing)]);
  const at = { workspaceId: legacy.workspaceId, epoch: id(2) };
  const credential: Credential = { ticket: { kind: 'visitor', workspaceId: at.workspaceId, id: id(3), expiresAt: '2099-01-01T00:00:00Z' } };
  const http = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init), { credential, entering: false });
  const base = (encounterId: string) => `/api/his/encounters/${encounterId}/billing`;
  const read = async (encounterId: string) => accountSchema.parse(await (await http(base(encounterId))).json());
  const command = async (encounterId: string, name: string, fields: Record<string, unknown>) => {
    const version = (await read(encounterId)).version;
    const response = await http(`${base(encounterId)}/${name}`, { method: 'POST', body: JSON.stringify({ ...fields, expectedVersion: version, epoch: at.epoch, idempotencyKey: crypto.randomUUID() }) });
    return z.record(z.string(), z.json()).parse(await response.json());
  };
  const outpatient = id(7), inpatient = id(8);
  const restored = await read(outpatient);
  const fields = { chargeId: id(17), paymentId: id(22), reason: 'Remaining original refund' };
  const excessive = await command(outpatient, 'refund.allocation.preview', { ...fields, amountMinor: 41 });
  const refund = await command(outpatient, 'refund.allocation.preview', { ...fields, amountMinor: 40 });
  await command(outpatient, 'refund.allocation.confirm', { commitToken: refund.commitToken });
  const deposit = await command(inpatient, 'inpatient.deposit.preview', { amountMinor: 100 });
  const deposited = await command(inpatient, 'inpatient.deposit.confirm', { commitToken: deposit.commitToken });
  const freeze = await command(inpatient, 'inpatient.settlement.preview', {});
  await command(inpatient, 'inpatient.discharge.settle', { commitToken: freeze.commitToken });
  const adjustments = [];
  for (const amountMinor of [-20, -30]) {
    const item = await command(inpatient, 'inpatient.correction', { chargeId: id(18), amountMinor, reason: `Teaching correction ${amountMinor}` });
    adjustments.push(item.adjustmentId);
  }
  const returnFields = { correctionId: adjustments[0], paymentId: deposited.paymentId, reason: 'Original ward deposit' };
  const overCorrection = await command(inpatient, 'inpatient.refund.preview', { ...returnFields, amountMinor: 21 });
  const within = await command(inpatient, 'inpatient.refund.preview', { ...returnFields, amountMinor: 20 });
  await command(inpatient, 'inpatient.refund.confirm', { commitToken: within.commitToken });
  const ward = await read(inpatient);
  const originalRules = await http(`/api/his/encounters/${inpatient}/payer`);
  const clearance = await store.read(reader => billing.readAdmissionFunds(reader, at, inpatient));
  const final = await read(outpatient);
  return { restoredPaid: restored.cashMinor, refundedBefore: restored.charges[0]!.refundedMinor, excessive: excessive.code, finalPaid: final.cashMinor, tenders: refund.tenders, overCorrection: overCorrection.code, remaining: ward.corrections.map(item => item.remainingMinor), linked: ward.payments.at(-1)?.correctionId === adjustments[0], clearance, originalRules: { status: originalRules.status, data: await originalRules.json() }, frozenMinor: ward.settlement?.netMinor };
}
