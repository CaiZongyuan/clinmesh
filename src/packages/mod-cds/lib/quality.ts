import { v7 } from 'uuid';
import { medicationSchema } from '../../data-pack';
import { completedWardProcedures } from '../../mod-inpatient';
import { CoreError, overrideSchema, type ClinicalQualityGate, type ClinicalQualityIntent } from '../../platform';
import type { StoreReader, StoreScope } from '../../store';
import { catalogCoding, clinicalFacts, sameCoding, type ClinicalFacts, type LegacyEcg } from './facts';
import { normalizeCreatinineMgDl } from './scores';

export const drugDefinitions = (data: ClinicalFacts) => data.catalog.filter(row => row.kind === 'medications').map(row => ({ id: row.id, ...medicationSchema.parse(row.definition) }));
type Medication = ReturnType<typeof drugDefinitions>[number];

export function activeDrugs(reader: StoreReader, at: StoreScope, data: ClinicalFacts, inpatientIds?: readonly string[]) {
  const ids = new Set(inpatientIds ?? data.orders.filter(order => order.kind === 'medication' && ['signed', 'verified'].includes(order.status)).map(order => order.catalog_item_id));
  for (const visit of reader.list(at, 'encounters', { patient_id: data.patient.id, encounter_class: 'outpatient' })) {
    for (const order of reader.list(at, 'clinical_orders', { encounter_id: visit.id, kind: 'medication' })) {
      const line = reader.list(at, 'prescription_directions', { order_id: order.id })[0];
      if (!line || order.status === 'cancelled') continue;
      const since = Date.parse(order.virtual_at);
      if (since <= Date.parse(data.now) && since + line.directions.days * 86400000 > Date.parse(data.now)) ids.add(order.catalog_item_id);
    }
  }
  return drugDefinitions(data).filter(item => ids.has(item.id));
}

export function incompatible(data: ClinicalFacts, first: Medication, second: Medication) {
  return sameCoding(first.ingredient ?? first, second.ingredient ?? second) || Boolean(data.knowledge.pharmacy?.classConflicts.some(([left, right]) =>
    (first.safety.classCodes.includes(left) && second.safety.classCodes.includes(right)) || (first.safety.classCodes.includes(right) && second.safety.classCodes.includes(left))));
}

export function drugContraindication(data: ClinicalFacts, drug: Medication) {
  const allergies = data.caseView.priorHistory.allergies;
  if (allergies.status === 'confirmed' && allergies.items.some(item => drug.safety.allergyGroupCodes.includes(item.groupCode))) return 'MEDICATION_ALLERGY_CONFLICT';
  if (data.egfr !== null && drug.safety.contraindicatedEgfrBelow !== undefined && data.egfr < drug.safety.contraindicatedEgfrBelow) return 'RENAL_CONTRAINDICATED_MEDICATION';
}

export const renalRisk = (drug: Medication) => drug.safety.contraindicatedEgfrBelow !== undefined || drug.safety.classCodes.some(code => ['biguanide', 'sglt2', 'mra'].includes(code));
export function recentCreatinine(data: ClinicalFacts) {
  const sample = data.currentCreatinine;
  if (!sample || typeof sample.value !== 'number' || Date.parse(data.now) - Date.parse(sample.observedAt) > 30 * 86400000) return false;
  try { normalizeCreatinineMgDl(sample.value, sample.unit); return true; } catch { return false; }
}
const antibacterial = (drug: Medication) => drug.safety.classCodes.some(code => ['antibacterial', 'penicillin'].includes(code));

export function completedPci(reader: StoreReader, at: StoreScope, data: ClinicalFacts) {
  if (completedWardProcedures(reader, at, data.encounter.id).some(stage => stage.kind === 'pci')) return true;
  return data.orders.some(order => reader.list(at, 'surgery_requests', { order_id: order.id }).some(request => {
    if (reader.list(at, 'ward_surgery_stages', { request_id: request.id }).length) return false;
    const procedure = data.byId.get(request.procedure_item_id);
    return procedure && data.knowledge.cds?.pciProcedures.some(code => sameCoding(code, catalogCoding(procedure))) && reader.list(at, 'surgery_executions', { surgery_request_id: request.id }).some(event => event.outcome === 'completed');
  }));
}

export function qualityIssues(reader: StoreReader, at: StoreScope, data: ClinicalFacts, intent: ClinicalQualityIntent) {
  const red = new Set<string>();
  const alerts = new Set<string>();
  if (intent.kind === 'medication') {
    const catalog = drugDefinitions(data);
    const active = activeDrugs(reader, at, data, intent.activeMedicationIds);
    for (const line of intent.lines) {
      const drug = catalog.find(item => sameCoding(item, line));
      if (!drug) continue;
      const contraindication = drugContraindication(data, drug);
      if (contraindication) red.add(contraindication);
      if (line.dose > drug.safety.maxSingleDose || line.dose * line.timesPerDay > drug.safety.maxDailyDose) red.add('MEDICATION_DOSE_LIMIT_EXCEEDED');
      if (active.some(other => incompatible(data, drug, other))) red.add('MEDICATION_CLASS_DUPLICATION');
      active.push(drug);
      if (renalRisk(drug) && !recentCreatinine(data)) alerts.add('RENAL_CREATININE_MISSING');
      const viral = (code: string) => /^(J00|J06|B34)/.test(code);
      if (antibacterial(drug) && data.codes.some(viral) && !data.codes.some(code => !viral(code) && drug.safety.indicationPrefixes.some(prefix => code.startsWith(prefix)))) alerts.add('ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION');
    }
  } else if (intent.kind === 'complete' && data.encounter.encounter_class === 'outpatient') {
    if ((data.bedside.acuteChestPain || data.codes.some(code => /^(R07|I20\.0|I21|I22|I24)/.test(code))) && (!data.firstEcg || !data.biomarker)) alerts.add('CHEST_PAIN_WORKUP_INCOMPLETE');
  } else if (intent.kind === 'pci') {
    const measurements = data.reports.flatMap(report => {
      const procedure = data.knowledge.inpatient?.procedures.find(rule => rule.kind === 'angiography' && rule.reportService && sameCoding(rule.reportService, report.service));
      if (!procedure && report.service.modality !== 'coronary-angiography') return [];
      const declared = procedure?.ffr ? [procedure.ffr] : data.knowledge.cds?.ffrAnalytes ?? [];
      return [{ value: report.findings.observations.find(item => item.unit === '1' && declared.some(code => sameCoding(code, item)))?.value }];
    });
    const ffr = intent.ffr ?? measurements.at(-1)?.value;
    if (typeof ffr === 'number' && ffr > 0.8 && ffr <= 1) alerts.add('PCI_NON_ISCHEMIC_LESION');
  } else if (intent.kind === 'discharge' && (data.facts.confirmedDiagnoses.some(item => /^I2[0-5]/.test(item.code)) || intent.completedPci || completedPci(reader, at, data))) {
    const ids = new Set(intent.activeMedicationIds ?? data.orders.filter(order => order.kind === 'medication' && ['signed', 'verified'].includes(order.status)).map(order => order.catalog_item_id));
    const classes = drugDefinitions(data).filter(drug => ids.has(drug.id)).flatMap(drug => drug.safety.classCodes);
    if (!classes.some(code => ['antiplatelet-aspirin', 'p2y12'].includes(code))) alerts.add('DISCHARGE_ANTIPLATELET_MISSING');
    if (!classes.includes('statin')) alerts.add('DISCHARGE_STATIN_MISSING');
  }
  return { red: [...red].sort(), alerts: [...alerts].sort() };
}

export const clinicalQualityGate = (legacy: LegacyEcg): ClinicalQualityGate => (context, intent, input, operation) => {
  if (intent.kind === 'investigation') return;
  const { tx, at, actor, virtualAt, recordedAt } = context;
  const data = clinicalFacts(tx, at, intent.encounterId, legacy);
  const { red, alerts } = qualityIssues(tx, at, data, intent);
  if (red.length) throw new CoreError(409, 'CLINICAL_QUALITY_RED_LINE', { ruleCodes: red.join(',') });
  if (!alerts.length) return;
  const override = overrideSchema.safeParse(input).data;
  if (!override || override.ruleCodes.toSorted().join(',') !== alerts.join(',')) throw new CoreError(409, 'CLINICAL_QUALITY_ALERT', { ruleCodes: alerts.join(',') });
  if (actor.kind !== 'visitor' || !actor.role.capabilities.includes('sign') || data.encounter.active_practitioner_role !== actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  for (const rule of alerts) {
    const id = v7();
    const auditId = v7();
    const times = { virtual_at: virtualAt, recorded_at: recordedAt };
    tx.insert(at, 'clinical_overrides', { id, encounter_id: intent.encounterId, rule_code: rule, rationale: override.note, practitioner_role: actor.role.id, ...times });
    tx.insert(at, 'audit_events', { id: auditId, actor: actor.id, practitioner_role: actor.role.id, operation: 'clinical.override', target_id: id, outcome: 'applied', ...times });
    tx.insert(at, 'clinical_override_reasons', { id, audit_id: auditId, reason_code: override.reasonCode, command_name: operation });
  }
  return alerts;
};
