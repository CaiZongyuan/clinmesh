import { z } from 'zod';
import { accountSchema, createBillingModule } from '../../packages/mod-billing';
import { createDrgModule } from '../../packages/mod-drg-cn';
import type { Credential } from '../../packages/platform';
import type { StorePort } from '../../packages/store';
import { createWorkspaceApp } from '../workspace';
import legacy from './fixtures/2f49e201-v2.json';

const id = (number: number) => `0192eaf2-cb03-7000-8000-${String(number).padStart(12, '0')}`;
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
