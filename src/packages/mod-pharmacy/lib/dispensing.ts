import { v7 } from 'uuid';
import { z } from 'zod';
import { pharmacyKnowledgeSchema } from '../../data-pack';
import { CoreError, localizedName, type CommandContext } from '../../platform';
import { StoreInsufficientInventoryError, type StoreReader, type StoreScope, type StoreTx } from '../../store';
import { allergiesFor, allergiesSchema, outpatient, readPrescription, requireSigned, type PharmacyBillingPort } from './clinical';

const lotSchema = z.object({ lotId: z.uuidv7(), lotNumber: z.string(), expiryDate: z.iso.date(), unit: z.string(), available: z.int().positive() });
const queueLine = z.object({ orderId: z.uuidv7(), display: localizedName, dose: z.number(), doseUnit: z.string(), routeCode: z.string(),
  timesPerDay: z.int(), days: z.int(), quantity: z.int().positive(), lots: z.array(lotSchema) });
export const dispenseQueueSchema = z.array(z.object({ prescriptionId: z.uuidv7(), encounterId: z.uuidv7(), patientName: z.string(),
  version: z.int(), allergies: allergiesSchema, lines: z.array(queueLine) }));
export const selectedLotSchema = z.strictObject({ orderId: z.uuidv7(), lotId: z.uuidv7(), quantity: z.int().positive() });
export const dispenseReceipt = z.object({ version: z.int(), allocations: z.array(selectedLotSchema.extend({ lotNumber: z.string(), dispenseId: z.uuidv7() })) });

export function initializePharmacy(tx: StoreTx, at: StoreScope, virtualAt: string, recordedAt: string) {
  const settings = tx.list(at, 'data_pack_installations')[0]!.knowledge.pharmacy;
  if (!settings) return;
  const { openingStock } = pharmacyKnowledgeSchema.parse(settings);
  for (const lot of openingStock) for (const code of lot.medicationCodes) {
    const [item] = tx.list(at, 'catalog_items', { kind: 'medications', code_system: lot.codeSystem, code });
    const lotId = v7();
    tx.insert(at, 'inventory_lots', { id: lotId, catalog_item_id: item!.id, lot_number: lot.lotNumber, expiry_date: lot.expiryDate, unit: lot.unit });
    tx.insert(at, 'inventory_movements', { id: v7(), lot_id: lotId, quantity_delta: lot.quantity, reason: 'opening-stock', virtual_at: virtualAt, recorded_at: recordedAt });
  }
}

function stockDate(reader: StoreReader, at: StoreScope, virtualTime: string) {
  const { timezone } = z.object({ timezone: z.string() }).parse(reader.list(at, 'data_pack_installations')[0]!.manifest);
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(virtualTime));
}

export function availableStock(reader: StoreReader, at: StoreScope, catalogItemId: string, date: string) {
  return reader.list(at, 'inventory_lots', { catalog_item_id: catalogItemId }).flatMap(lot => {
    if (lot.expiry_date < date || reader.get(at, 'inventory_lot_quarantines', lot.id)) return [];
    const available = reader.list(at, 'inventory_movements', { lot_id: lot.id }).reduce((total, movement) => total + movement.quantity_delta, 0);
    return available > 0 ? [{ lotId: lot.id, lotNumber: lot.lot_number, expiryDate: lot.expiry_date, unit: lot.unit, available }] : [];
  }).sort((first, second) => first.expiryDate.localeCompare(second.expiryDate) || first.lotNumber.localeCompare(second.lotNumber));
}

export function takeStock(tx: StoreTx, at: StoreScope, lotId: string, quantity: number, reason: string, virtualAt: string, recordedAt: string) {
  const movementId = v7();
  try { tx.insert(at, 'inventory_movements', { id: movementId, lot_id: lotId, quantity_delta: -z.int().positive().parse(quantity), reason, virtual_at: virtualAt, recorded_at: recordedAt }); }
  catch (error) { if (error instanceof StoreInsufficientInventoryError) throw new CoreError(409, 'PHARMACY_INSUFFICIENT_STOCK'); throw error; }
  return movementId;
}

function releaseIssue(reader: StoreReader, at: StoreScope, rx: ReturnType<typeof readPrescription>, billing?: PharmacyBillingPort) {
  if (rx.source !== 'internal') return 'PRESCRIPTION_EXTERNAL';
  if (outpatient(reader, at, rx.encounterId).status !== 'completed') return 'ENCOUNTER_NOT_COMPLETED';
  if (billing && rx.lines.some(({ orderId }) => !['free', 'settled'].includes(billing.readOrderFunds(reader, at, orderId).state))) return 'PRESCRIPTION_PAYMENT_REQUIRED';
}

export function dispenseQueue(reader: StoreReader, at: StoreScope, virtualAt: string, billing?: PharmacyBillingPort) {
  const date = stockDate(reader, at, virtualAt);
  return reader.list(at, 'prescription_signatures', { source: 'internal' }).flatMap(({ prescription_id }) => {
    const rx = readPrescription(reader, at, prescription_id);
    if (rx.status !== 'signed' || releaseIssue(reader, at, rx, billing)) return [];
    const encounter = outpatient(reader, at, rx.encounterId);
    return [{ prescriptionId: rx.prescriptionId, encounterId: rx.encounterId, patientName: reader.get(at, 'patients', encounter.patient_id)!.display_name,
      version: rx.version, allergies: allergiesFor(reader, at, encounter), lines: rx.lines.map(line => ({ ...line, lots: availableStock(reader, at, reader.get(at, 'clinical_orders', line.orderId)!.catalog_item_id, date) })) }];
  });
}

export function dispensePrescription(context: CommandContext, selections: z.infer<typeof selectedLotSchema>[] | undefined, billing?: PharmacyBillingPort) {
  const { tx, at, targetId, expectedVersion, virtualAt, recordedAt } = context;
  const rx = readPrescription(tx, at, targetId);
  requireSigned(rx, expectedVersion);
  const blocked = releaseIssue(tx, at, rx, billing);
  if (blocked) throw new CoreError(409, blocked);
  if (selections?.some(selection => !rx.lines.some(line => line.orderId === selection.orderId))) throw new CoreError(409, 'PHARMACY_LOT_MISMATCH');
  const date = stockDate(tx, at, virtualAt);
  const allocations: z.infer<typeof dispenseReceipt>['allocations'] = [];
  for (const line of rx.lines) {
    const lots = availableStock(tx, at, tx.get(at, 'clinical_orders', line.orderId)!.catalog_item_id, date);
    const selected = selections?.filter(item => item.orderId === line.orderId);
    if (selected && (new Set(selected.map(item => item.lotId)).size !== selected.length || selected.reduce((quantity, item) => quantity + item.quantity, 0) !== line.quantity ||
      selected.some(item => !lots.some(lot => lot.lotId === item.lotId)))) throw new CoreError(409, 'PHARMACY_LOT_MISMATCH');
    const [binding] = tx.list(at, 'prescription_orders', { order_id: line.orderId });
    let remaining = line.quantity;
    for (const lot of lots) {
      const quantity = selected ? selected.find(item => item.lotId === lot.lotId)?.quantity ?? 0 : Math.min(remaining, lot.available);
      if (!quantity) continue;
      const movementId = takeStock(tx, at, lot.lotId, quantity, 'dispense', virtualAt, recordedAt);
      const dispenseId = v7();
      const times = { virtual_at: virtualAt, recorded_at: recordedAt };
      tx.insert(at, 'dispenses', { id: dispenseId, prescription_order_id: binding!.id, movement_id: movementId, quantity, ...times });
      allocations.push({ orderId: line.orderId, lotId: lot.lotId, lotNumber: lot.lotNumber, quantity, dispenseId });
      remaining -= quantity;
      if (!remaining) break;
    }
    if (remaining) throw new CoreError(409, 'PHARMACY_INSUFFICIENT_STOCK');
  }
  tx.update(at, 'prescriptions', targetId, expectedVersion, { status: 'dispensed' });
  return { version: expectedVersion + 1, allocations };
}
