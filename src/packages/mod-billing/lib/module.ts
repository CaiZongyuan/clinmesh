import { z } from 'zod';
import type { CommandContext, OperationCatalog } from '../../platform';
import type { StoreReader, StoreScope, StoreTx } from '../../store';
import { account, clinicalAccount, encounterStarted, facility, freezeCharge, freezeMaterialUse, readOrderFunds, reconcile } from './account';
import { accountSchema, cashierQueueSchema, chargeIds, id, positive, reason, simulation, snapshotSchema, tenders, type BillingOptions } from './contracts';
import { adjust, collect, confirm, currentBill, deposit, paymentResult, preview, previewSchema, recover, refund, settle, settlementPlan } from './payments';

const base = '/api/his/encounters/:id/billing';
const cashier = { capabilities: ['settle'], visitorOnly: true };
const route = (name: string) => ({ name, path: `${base}/${name}`, method: 'POST' as const, access: cashier });

export function createBillingModule(options: BillingOptions = {}) {
  return {
    id: 'mod-billing', kind: 'clinical' as const, version: '1', workbenchTabs: [{ id: 'billing', label: { en: 'Cashier', zh: '收费工作台' } }], freezeCharge, freezeMaterialUse, encounterStarted,
    readOrderFunds: (reader: StoreReader, at: StoreScope, orderId: string) => readOrderFunds(reader, at, orderId, options),
    readAccount: (reader: StoreReader, at: StoreScope, encounterId: string) => account(reader, at, encounterId, options),
    readAdmissionFunds(reader: StoreReader, at: StoreScope, encounterId: string) {
      if (facility(reader, at).policy === 'free') return { outstandingMinor: 0, canClearBed: true, locked: false };
      const bill = clinicalAccount(reader, at, encounterId, options);
      const unresolved = bill.pending || bill.payerPending || bill.unpostedSources.length > 0;
      return { outstandingMinor: unresolved ? null : Math.max(0, bill.balanceMinor), canClearBed: bill.policy === 'free' || (!unresolved && !bill.balanceMinor && Boolean(bill.settlement)), locked: Boolean(bill.settlement) };
    },
    reconcile: (tx: StoreTx, at: StoreScope, encounterId: string, virtualAt: string, recordedAt: string) => reconcile(tx, at, encounterId, virtualAt, recordedAt, options),
    registerOperations(catalog: OperationCatalog) {
      const read = (context: CommandContext) => currentBill(context, options);
      catalog.query({ name: 'billing.account', path: base, access: { capabilities: ['settle'] } }, accountSchema, ({ reader, actor, targetId }) => account(reader, actor.at, targetId, options));
      catalog.query({ name: 'billing.queue', path: '/api/his/billing/queue', access: { capabilities: ['settle'] } }, cashierQueueSchema, ({ reader, actor }) => {
        const names = new Map(reader.list(actor.at, 'patients').map(patient => [patient.id, patient.display_name]));
        return reader.list(actor.at, 'encounters').map(row => ({ encounterId: row.id, name: names.get(row.patient_id)!, encounterClass: row.encounter_class }));
      });
      catalog.command(route('payment.preview'), { chargeIds, amountMinor: positive.optional(), tenders: tenders.optional(), simulation }, previewSchema, (ctx, input) => { const bill = read(ctx); return preview(ctx, bill, collect(bill, input)); });
      catalog.command(route('refund.allocation.preview'), { chargeId: id, paymentId: id, amountMinor: positive, reason, simulation }, previewSchema, (ctx, input) => { const bill = read(ctx); return preview(ctx, bill, refund(bill, input)); });
      catalog.command(route('inpatient.deposit.preview'), { amountMinor: positive, tenders: tenders.optional(), correctionId: id.optional(), simulation }, previewSchema, (ctx, input) => { const bill = read(ctx); return preview(ctx, bill, deposit(bill, input)); });
      catalog.command(route('inpatient.refund.preview'), { paymentId: id, amountMinor: positive, correctionId: id.optional(), reason, simulation }, previewSchema, (ctx, input) => { const bill = read(ctx); return preview(ctx, bill, refund(bill, input)); });
      for (const [name, kind] of [['payment.confirm', 'collection'], ['refund.allocation.confirm', 'refund'], ['inpatient.deposit.confirm', 'deposit'], ['inpatient.refund.confirm', 'deposit-refund']] as const) {
        catalog.command(route(name), { commitToken: id }, paymentResult, (ctx, { commitToken }) => confirm(ctx, currentBill(ctx, options, false), options, commitToken, kind));
      }
      catalog.command(route('payment.recover'), { paymentId: id, paymentVersion: positive }, paymentResult, (ctx, input) => recover(ctx, read(ctx), input.paymentId, input.paymentVersion, options));
      catalog.command(route('charge.adjust'), { chargeId: id, amountMinor: positive, reason }, z.object({ adjustmentId: id }), (ctx, input) => adjust(ctx, read(ctx), input, false, options));
      catalog.command(route('inpatient.correction'), { chargeId: id, amountMinor: z.int().refine(value => value !== 0), reason }, z.object({ adjustmentId: id }), (ctx, input) => adjust(ctx, read(ctx), input, true, options));
      catalog.command(route('inpatient.settlement.preview'), {}, previewSchema, ctx => { const bill = read(ctx); return preview(ctx, bill, settlementPlan(bill)); });
      catalog.command(route('inpatient.discharge.settle'), { commitToken: id }, snapshotSchema, (ctx, { commitToken }) => settle(ctx, read(ctx), commitToken));
    },
  };
}
