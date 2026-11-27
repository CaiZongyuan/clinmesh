import { z } from 'zod';
import { requireEncounter } from '../../patient-visit';
import type { Actor, ClinMeshModule, OperationCatalog } from '../../platform';
import { hasMedicationDecision, prescribingView, prescribingViewSchema, recordNoMedication, signPrescription, withdrawPrescription, type PharmacyBillingPort } from './clinical';
import { dispensePrescription, dispenseQueue, dispenseQueueSchema, dispenseReceipt, initializePharmacy, selectedLotSchema } from './dispensing';
import { prescriptionLineSchema } from './safety';

const sign = { capabilities: ['sign'], visitorOnly: true };
const dispense = { capabilities: ['dispense'], visitorOnly: true };
const encounters = '/api/his/encounters/:id';
const prescriptions = '/api/his/prescriptions/:id';
const version = z.object({ version: z.int().positive() });
const reason = z.string().trim().min(1).max(1000);

export function createPharmacyModule(billing?: PharmacyBillingPort): ClinMeshModule<OperationCatalog> {
  const funds = (actor: Actor) => actor.enabledModules.includes('mod-billing') ? billing : undefined;
  return { id: 'mod-pharmacy', kind: 'clinical', version: '1.0.0', initializeEpoch: initializePharmacy,
    workbenchTabs: [{ id: 'prescriptions', label: { en: 'Prescriptions', zh: '处方' }, readOperation: 'prescription.read' }],
    completion(reader, at, id) {
      if (requireEncounter(reader, at, id).encounter_class !== 'outpatient' || !reader.list(at, 'data_pack_installations')[0]?.knowledge.pharmacy) return [];
      return [{ id: 'medication-decision', label: { en: 'Prescription or no medication', zh: '已签发处方或确认无需用药' }, passed: hasMedicationDecision(reader, at, id) }];
    },
    registerOperations(catalog) {
      catalog.query({ name: 'prescription.read', path: `${encounters}/prescriptions`, access: { capabilities: ['assess', 'sign'] }, assistantRead: 'encounter' }, prescribingViewSchema, ({ reader, actor, targetId }) => prescribingView(reader, actor.at, targetId));
      catalog.command({ name: 'prescription.sign', method: 'POST', path: `${encounters}/prescriptions`, access: sign },
        { lines: z.array(prescriptionLineSchema).max(64), clinicalOverride: z.unknown().optional(), override: z.unknown().optional(), overrideReason: z.string().optional() }, version.extend({ prescriptionId: z.uuidv7(), snapshotHash: z.string() }), (context, input) => signPrescription(context, input.lines, funds(context.actor), input.clinicalOverride));
      catalog.command({ name: 'prescription.no-medication', method: 'POST', path: `${encounters}/no-medication`, access: sign }, { reason }, version.extend({ conclusionId: z.uuidv7() }), (context, input) => recordNoMedication(context, input.reason));
      catalog.command({ name: 'prescription.withdraw', method: 'POST', path: `${prescriptions}/withdraw`, access: sign }, { reason, noMedicationReason: reason.optional() }, version.extend({ conclusionId: z.uuidv7().nullable().default(null) }), (context, input) => withdrawPrescription(context, input.reason, input.noMedicationReason, funds(context.actor)));
      catalog.query({ name: 'pharmacy.queue', path: '/api/his/pharmacy/queue', access: { capabilities: ['dispense'] } }, dispenseQueueSchema, ({ reader, actor }) => dispenseQueue(reader, actor.at, actor.active.virtual_time, funds(actor)));
      catalog.command({ name: 'pharmacy.dispense', method: 'POST', path: `${prescriptions}/dispense`, access: dispense }, { lots: z.array(selectedLotSchema).min(1).max(8000).optional() }, dispenseReceipt, (context, input) => dispensePrescription(context, input.lots, funds(context.actor)));
    },
  };
}
