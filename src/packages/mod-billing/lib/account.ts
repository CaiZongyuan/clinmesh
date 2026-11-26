import { v7 } from 'uuid';
import { z } from 'zod';
import { manifestSchema } from '../../data-pack';
import { requireEncounter } from '../../patient-visit';
import { CoreError } from '../../platform';
import type { StoreReader, StoreScope, StoreTx } from '../../store';
import { accountSchema, amount, snapshotSchema, tender, type Attempt, type BillingOptions, type FrozenCharge, type OrderFunds } from './contracts';
import { requireDenomination, sumMinor, type Currency } from './money';
import { correctionBalances } from './corrections';

export function conflict(code: string): never { throw new CoreError(409, code); }
export function facility(reader: StoreReader, at: StoreScope) {
  const installation = reader.list(at, 'data_pack_installations')[0]!;
  const manifest = manifestSchema.parse(installation.manifest);
  const policy = manifest.enabledModules.includes('mod-billing') ? manifest.policies.outpatientInvestigationBillingPolicy : 'free';
  return { installation, manifest, policy };
}

function paymentHistory(reader: StoreReader, at: StoreScope, encounterId: string, currency: Currency): Attempt[] {
  const history: Attempt[] = [];
  for (const payment of reader.list(at, 'payment_transactions', { encounter_id: encounterId })) {
    requireDenomination(payment, currency);
    const attempt = reader.list(at, 'billing_attempts', { payment_id: payment.id })[0];
    const recovery = reader.list(at, 'billing_recoveries', { payment_id: payment.id })[0];
    const channels = reader.list(at, 'payment_tenders', { payment_id: payment.id });
    const byCharge = new Map<string, number>();
    const tenderAllocations: Attempt['tenderAllocations'] = [];
    for (const channel of channels) {
      requireDenomination(channel, currency);
      for (const item of reader.list(at, 'payment_allocations', { tender_id: channel.id })) {
        requireDenomination(item, currency);
        byCharge.set(item.charge_id, sumMinor([byCharge.get(item.charge_id) ?? 0, item.amount_minor]));
        tenderAllocations.push({ chargeId: item.charge_id, method: channel.method, amountMinor: item.amount_minor });
        for (const legacy of reader.list(at, 'refund_transactions', { allocation_id: item.id })) {
          requireDenomination(legacy, currency);
          const returned = { chargeId: item.charge_id, method: channel.method, amountMinor: legacy.amount_minor };
          history.push({ id: legacy.id, kind: 'refund', originId: payment.id, status: 'succeeded', version: 1, correctionId: null, recordedAt: legacy.recorded_at, amountMinor: returned.amountMinor, allocations: [{ chargeId: returned.chargeId, amountMinor: returned.amountMinor }], tenders: [{ method: returned.method, amountMinor: returned.amountMinor }], tenderAllocations: [returned] });
        }
      }
    }
    const plan = attempt ? reader.get(at, 'billing_previews', attempt.preview_id)?.plan : undefined;
    history.push({ id: payment.id, kind: attempt?.kind ?? 'collection', originId: attempt?.origin_id ?? null, status: recovery?.status ?? attempt?.initial_status ?? 'succeeded', version: recovery ? 2 : 1,
      correctionId: z.uuidv7().nullish().parse(plan?.correctionId) ?? null, tenderAllocations, amountMinor: payment.amount_minor, recordedAt: payment.recorded_at, tenders: channels.map(row => tender.parse({ method: row.method, amountMinor: row.amount_minor })), allocations: [...byCharge].map(([chargeId, amountMinor]) => ({ chargeId, amountMinor })) });
  }
  return history.sort((first, second) => first.recordedAt.localeCompare(second.recordedAt) || first.id.localeCompare(second.id));
}

const withdrawn = (status: string | undefined) => status === 'cancelled' || status === 'withdrawn';
const businessDay = (instant: string, timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));

function registrationService(reader: StoreReader, at: StoreScope) {
  const registrations = reader.list(at, 'catalog_items', { kind: 'services' }).filter(item => item.definition.kind === 'registration');
  if (registrations.length > 1) conflict('AMBIGUOUS_REGISTRATION_SERVICE');
  return registrations[0];
}

export function encounterStarted(tx: StoreTx, at: StoreScope, encounterId: string, virtualAt: string, recordedAt: string) {
  const { manifest, policy } = facility(tx, at);
  if (policy === 'free' || requireEncounter(tx, at, encounterId).encounter_class !== 'outpatient') return;
  const item = registrationService(tx, at);
  if (!item?.amount_minor) return;
  if (item.currency_code !== manifest.currency.code || item.currency_exponent !== manifest.currency.minorUnitExponent) conflict('CHARGE_SOURCE_CONFLICT');
  const display = z.object({ en: z.string(), zh: z.string() }).parse(item.definition.display);
  tx.insert(at, 'charge_items', { id: encounterId, encounter_id: encounterId, order_id: null, description: display[manifest.defaultLocale.startsWith('zh') ? 'zh' : 'en'], amount_minor: item.amount_minor, currency_code: manifest.currency.code, currency_exponent: manifest.currency.minorUnitExponent, virtual_at: virtualAt, recorded_at: recordedAt });
}

function materialSource(reader: StoreReader, at: StoreScope, useId: string) {
  const use = reader.get(at, 'material_uses', useId);
  if (!use) return undefined;
  const reservation = reader.get(at, 'material_reservations', use.reservation_id)!;
  const lot = reader.get(at, 'inventory_lots', reservation.lot_id)!;
  const item = reader.get(at, 'catalog_items', lot.catalog_item_id)!;
  const request = reader.get(at, 'surgery_requests', reservation.surgery_request_id)!;
  const order = reader.get(at, 'clinical_orders', request.order_id)!;
  return { use, item, encounterId: order.encounter_id };
}

export function freezeMaterialUse(tx: StoreTx, at: StoreScope, useId: string) {
  const { manifest, policy } = facility(tx, at);
  if (policy === 'free') return null;
  const { use, item, encounterId } = materialSource(tx, at, useId) ?? conflict('MATERIAL_USE_REQUIRED');
  if (item.kind !== 'materials' || item.amount_minor === null || item.currency_code !== manifest.currency.code || item.currency_exponent !== manifest.currency.minorUnitExponent) conflict('CHARGE_SOURCE_CONFLICT');
  const amountMinor = amount.parse(Number(BigInt(item.amount_minor) * BigInt(use.quantity)));
  const existing = tx.get(at, 'charge_items', useId);
  if (existing) {
    if (existing.encounter_id !== encounterId || existing.order_id !== null || existing.amount_minor !== amountMinor) conflict('CHARGE_SOURCE_CONFLICT');
    requireDenomination(existing, manifest.currency);
    return existing.id;
  }
  if (tx.list(at, 'billing_settlements', { encounter_id: encounterId }).length) conflict('BILLING_LOCKED');
  const display = z.object({ en: z.string(), zh: z.string() }).parse(item.definition.display);
  tx.insert(at, 'charge_items', { id: useId, encounter_id: encounterId, order_id: null, description: display[manifest.defaultLocale.startsWith('zh') ? 'zh' : 'en'], amount_minor: amountMinor, currency_code: manifest.currency.code, currency_exponent: manifest.currency.minorUnitExponent, virtual_at: use.virtual_at, recorded_at: use.recorded_at });
  return useId;
}

export function account(reader: StoreReader, at: StoreScope, encounterId: string, options: BillingOptions) {
  const encounter = requireEncounter(reader, at, encounterId);
  const { manifest, policy } = facility(reader, at);
  const payments = paymentHistory(reader, at, encounterId, manifest.currency);
  const benefits = options.payerBenefit?.coverage(reader, at, encounterId);
  const admission = reader.list(at, 'inpatient_admissions', { encounter_id: encounterId })[0];
  const settlement = reader.list(at, 'billing_settlements', { encounter_id: encounterId })[0];
  const charges = reader.list(at, 'charge_items', { encounter_id: encounterId }).map(line => {
    requireDenomination(line, manifest.currency);
    const source = reader.list(at, 'charge_sources', { charge_id: line.id })[0];
    const registration = line.id === encounterId && !line.order_id ? registrationService(reader, at) : undefined;
    const material = !registration && !line.order_id ? materialSource(reader, at, line.id) : undefined;
    const order = line.order_id ? reader.get(at, 'clinical_orders', line.order_id) : undefined;
    const cancelled = withdrawn(order?.status);
    const adjustments = reader.list(at, 'charge_adjustments', { charge_id: line.id }).map(row => {
      requireDenomination(row, manifest.currency);
      return { id: row.id, reason: row.reason, amountMinor: row.amount_minor, virtualAt: row.virtual_at };
    });
    const assigned = payments.flatMap(payment => payment.allocations.filter(item => item.chargeId === line.id).map(item => ({ ...item, kind: payment.kind, status: payment.status, version: payment.version })));
    const success = assigned.filter(item => item.status === 'succeeded');
    const paidMinor = sumMinor(success.filter(item => item.kind === 'collection').map(item => item.amountMinor));
    const refundedMinor = sumMinor(success.filter(item => item.kind === 'refund').map(item => item.amountMinor));
    const netPaidMinor = paidMinor - refundedMinor;
    const benefit = benefits?.get(line.id);
    const coverageMinor = benefit?.amountMinor ?? 0;
    const adjustedMinor = sumMinor(adjustments.map(item => item.amountMinor));
    const netMinor = cancelled && !paidMinor && !coverageMinor ? 0 : sumMinor([line.amount_minor, adjustedMinor]);
    const releaseRecorded = Boolean(reader.list(at, 'billing_releases', { charge_id: line.id })[0]);
    const payerPending = Boolean(benefit?.requiresReview || (benefit?.basisMinor !== undefined && benefit.basisMinor !== netMinor));
    const pending = assigned.some(item => item.status === 'unknown');
    const outstandingMinor = Math.max(0, netMinor - coverageMinor - netPaidMinor);
    const released = !cancelled && !pending && !payerPending && (policy !== 'prepaid' || !outstandingMinor);
    return { id: line.id, orderId: line.order_id, materialUseId: material?.use.id ?? null, catalogItemId: source?.catalog_item_id ?? order?.catalog_item_id ?? registration?.id ?? material?.item.id ?? null, catalogVersion: source?.catalog_version ?? (registration || material ? manifest.version : null), quantity: source?.quantity ?? material?.use.quantity ?? 1, unitPriceMinor: source?.unit_price_minor ?? material?.item.amount_minor ?? line.amount_minor, description: line.description, department: source?.department ?? null, businessDay: source?.business_day ?? businessDay(line.virtual_at, manifest.timezone), amountMinor: line.amount_minor, adjustedMinor, netMinor, coverageMinor, payerRevision: benefit?.revision ?? 0, payerPending, refundedMinor, netPaidMinor, outstandingMinor, pending, cancelled, released, releaseRecorded,
      version: (order?.version ?? 1) + adjustments.length + sumMinor(assigned.map(item => item.version)) + (benefit?.revision ?? 0), adjustments };
  });
  const netMinor = sumMinor(charges.map(line => line.netMinor));
  const coverageMinor = sumMinor(charges.map(line => line.coverageMinor));
  const cashMinor = sumMinor(payments.filter(payment => payment.status === 'succeeded').map(payment => ['deposit-refund', 'refund'].includes(payment.kind) ? -payment.amountMinor : payment.amountMinor));
  const snapshot = settlement ? snapshotSchema.parse(settlement.snapshot) : null;
  const correctionCoverage = snapshot ? options.payerBenefit?.correctionCoverage?.(reader, at, encounterId) : undefined;
  return accountSchema.parse({ encounterId, encounterClass: encounter.encounter_class, admissionStatus: admission?.status ?? null, policy, currency: manifest.currency, charges, payments, netMinor, coverageMinor, cashMinor, balanceMinor: sumMinor([netMinor, -coverageMinor, -cashMinor]), pending: payments.some(payment => payment.status === 'unknown'), payerPending: charges.some(line => line.payerPending), settlement: snapshot, corrections: correctionBalances(snapshot, charges, payments, correctionCoverage),
    version: sumMinor([admission?.version ?? 0, settlement ? 1 : 0, ...payments.map(payment => payment.version), ...charges.map(line => line.version)]) });
}

export function freezeCharge(tx: StoreTx, at: StoreScope, row: FrozenCharge) {
  const { installation, manifest, policy } = facility(tx, at);
  if (policy === 'free') return null;
  const order = tx.get(at, 'clinical_orders', row.orderId);
  const item = tx.get(at, 'catalog_items', row.catalogItemId);
  if (!order || !item || order.encounter_id !== row.encounterId || order.catalog_item_id !== item.id || item.installation_id !== installation.id || installation.pack_version !== row.catalogVersion || item.amount_minor !== row.unitPriceMinor || item.currency_code !== row.currencyCode || item.currency_exponent !== row.currencyExponent || manifest.currency.code !== row.currencyCode || manifest.currency.minorUnitExponent !== row.currencyExponent) conflict('CHARGE_SOURCE_CONFLICT');
  const amountMinor = amount.parse(Number(BigInt(z.int().positive().parse(row.quantity)) * BigInt(row.unitPriceMinor)));
  const existing = tx.list(at, 'charge_sources', { order_id: row.orderId })[0];
  if (existing) {
    if (existing.quantity !== row.quantity || existing.department !== (row.department ?? null)) conflict('CHARGE_SOURCE_CONFLICT');
    return existing.charge_id;
  }
  if (tx.list(at, 'billing_settlements', { encounter_id: row.encounterId }).length) conflict('BILLING_LOCKED');
  if (withdrawn(order.status)) conflict('CHARGE_CANCELLED');
  const chargeId = v7();
  const display = z.object({ display: z.object({ en: z.string(), zh: z.string() }) }).parse(item.definition).display;
  tx.insert(at, 'charge_items', { id: chargeId, encounter_id: row.encounterId, order_id: row.orderId, description: display[manifest.defaultLocale.startsWith('zh') ? 'zh' : 'en'], amount_minor: amountMinor, currency_code: row.currencyCode, currency_exponent: row.currencyExponent, virtual_at: row.virtualAt, recorded_at: row.recordedAt });
  tx.insert(at, 'charge_sources', { id: v7(), charge_id: chargeId, order_id: row.orderId, catalog_item_id: item.id, catalog_version: row.catalogVersion, quantity: row.quantity, unit_price_minor: row.unitPriceMinor, department: row.department ?? null, business_day: businessDay(row.virtualAt, manifest.timezone) });
  return chargeId;
}

export function readOrderFunds(reader: StoreReader, at: StoreScope, orderId: string, options: BillingOptions): OrderFunds {
  const order = reader.get(at, 'clinical_orders', orderId);
  if (!order) throw new CoreError(404, 'ORDER_NOT_FOUND');
  if (facility(reader, at).policy === 'free') return { chargeId: null, state: 'free', released: !withdrawn(order.status), releaseRecorded: false, locked: false, netPaidMinor: 0 };
  const bill = clinicalAccount(reader, at, order.encounter_id, options);
  const line = bill.charges.find(line => line.orderId === orderId);
  const state = line?.pending || line?.payerPending ? 'unknown' : line && !line.outstandingMinor ? 'settled' : line && line.netPaidMinor + line.coverageMinor > 0 ? 'partial' : 'unpaid';
  return { chargeId: line?.id ?? null, state, released: line?.released ?? false, releaseRecorded: line?.releaseRecorded ?? false, locked: Boolean(bill.settlement || state === 'unknown' || line?.netPaidMinor || line?.coverageMinor || line?.refundedMinor), netPaidMinor: line?.netPaidMinor ?? 0 };
}

export function clinicalAccount(reader: StoreReader, at: StoreScope, encounterId: string, options: BillingOptions) {
  try { return account(reader, at, encounterId, options); }
  catch (error) {
    if (error instanceof CoreError && error.code === 'BILLING_CURRENCY_MISMATCH') throw new CoreError(409, error.code);
    throw error;
  }
}

export function reconcile(tx: StoreTx, at: StoreScope, encounterId: string, virtualAt: string, recordedAt: string, options: BillingOptions) {
  for (const line of account(tx, at, encounterId, options).charges) {
    if (!line.orderId || line.releaseRecorded || line.pending || line.payerPending || line.cancelled || line.outstandingMinor) continue;
    tx.insert(at, 'billing_releases', { id: v7(), charge_id: line.id, virtual_at: virtualAt, recorded_at: recordedAt });
    options.onRelease?.(tx, at, { encounterId, orderId: line.orderId, chargeId: line.id });
  }
}
