import { z } from 'zod';
import { clinicalFactId, clinicalFactSystem, triageMeasures } from '../../clinical-core';
import { studyReportSectionsSchema } from '../../diagnostic-studies';
import { signedFindingsSchema } from '../../mod-lab';
import { completedWardProcedures, signedAngiography, wardMedicationDeliveries, wardMedicationDirections } from '../../mod-inpatient';
import type { Actor } from '../../platform';
import type { EntityRow, StoreReader, StoreScope } from '../../store';

export const types = ['Patient', 'Encounter', 'Condition', 'Observation', 'ServiceRequest', 'DiagnosticReport', 'MedicationRequest', 'MedicationDispense', 'Procedure', 'Composition', 'AuditEvent'] as const;
export type ResourceType = typeof types[number];
type Resource = { resourceType: ResourceType; id: string; meta: { versionId: string; lastUpdated: string } } & Record<string, unknown>;
type Row = { resource: Resource; patient?: string; encounter?: string; current: boolean };
const ref = (type: string, id: string) => ({ reference: `${type}/${id}` });
const code = (system: string, value: string) => ({ coding: [{ system, code: value }] });
const actorRef = (value: string) => ({ identifier: { system: 'urn:clinmesh:practitioner-role', value } });
function identifierSystem(issuer: string, packId: string) {
  return URL.canParse(issuer) && !/\s/u.test(issuer) ? issuer : `urn:clinmesh:identifier-issuer:${encodeURIComponent(packId)}:${encodeURIComponent(issuer)}`;
}
const terminology = 'http://terminology.hl7.org/CodeSystem';
const local = clinicalFactSystem;
const serviceStatus = (status: string) => ['cancelled', 'withdrawn', 'stopped'].includes(status) ? 'revoked' : ['reported', 'acknowledged', 'completed', 'dispensed'].includes(status) ? 'completed' : status === 'generation-failed' ? 'entered-in-error' : 'active';
const medicationStatus = (status: string) => ['cancelled', 'withdrawn'].includes(status) ? 'cancelled' : status === 'stopped' ? 'stopped' : ['completed', 'dispensed'].includes(status) ? 'completed' : 'active';

export function projectResources(reader: StoreReader, actor: Actor, type: ResourceType) {
  const at = actor.at;
  const rows: Row[] = [];
  const visits = reader.list(at, 'encounters').filter(visit => actor.role.capabilities.includes('workspace-admin') || visit.active_practitioner_role === actor.role.id);
  const known = new Map(visits.map(visit => [visit.id, visit]));
  const emit = (id: string, version: number, updated: string, body: Record<string, unknown>, encounter?: string, patient?: string, current = true) => {
    rows.push({ resource: { resourceType: type, id, meta: { versionId: String(version), lastUpdated: updated }, ...body }, patient: patient ?? (encounter && known.get(encounter)?.patient_id), encounter, current });
  };
  if (type === 'Patient') {
    const packId = reader.list(at, 'data_pack_installations')[0]!.pack_id;
    const ids = new Set(visits.map(visit => visit.patient_id));
    for (const patient of reader.list(at, 'patients')) {
      if (!ids.has(patient.id) && !actor.role.capabilities.includes('workspace-admin')) continue;
      const versions = reader.list(at, 'patient_identity_versions', { patient_id: patient.id }).sort((first, second) => first.version - second.version);
      const identifiers = reader.list(at, 'patient_identifiers', { patient_id: patient.id });
      const timestamp = Number.parseInt(patient.id.slice(0, 8) + patient.id.slice(9, 13), 16);
      let updated = new Date(timestamp).toISOString();
      for (const item of [...versions, { ...patient, identifiers, replaced_at: null }]) {
        const identity = item.identifiers.map(identifier => ({ system: identifierSystem(identifier.issuer, packId), value: identifier.value }));
        emit(patient.id, item.version, updated, { name: [{ text: item.display_name }], ...(item.birth_date && { birthDate: item.birth_date }), ...(identity.length && { identifier: identity }) }, undefined, patient.id, item.replaced_at === null);
        if (item.replaced_at) updated = item.replaced_at;
      }
    }
    return rows;
  }
  if (type === 'AuditEvent') {
    for (const event of reader.list(at, 'audit_events')) {
      const observer = actorRef(event.practitioner_role);
      emit(event.id, 1, event.recorded_at, { code: code(local, event.operation), recorded: event.recorded_at, occurredDateTime: event.virtual_at,
        agent: [{ who: { identifier: { system: 'urn:clinmesh:participant', value: event.actor } }, role: [{ text: event.practitioner_role }], requestor: true }], source: { observer }, ...auditOutcome(event.outcome),
        entity: [{ what: { identifier: { system: 'urn:clinmesh:business-object', value: event.target_id } } }] });
    }
    return rows;
  }
  const catalog = new Map(reader.list(at, 'catalog_items').map(item => [item.id, code(item.code_system, item.code)]));
  for (const visit of visits) {
    const encounter = visit.id;
    const subject = ref('Patient', visit.patient_id);
    const context = { subject, encounter: ref('Encounter', encounter) };
    if (type === 'Encounter') {
      const states = reader.list(at, 'encounter_state_versions', { encounter_id: encounter }).sort((first, second) => first.version - second.version);
      let updated = visit.recorded_at;
      for (const item of [...states, visit]) {
        emit(encounter, item.version, updated, { subject, status: item.status === 'completed' ? 'completed' : 'in-progress', class: [code(`${terminology}/v3-ActCode`, visit.encounter_class === 'inpatient' ? 'IMP' : 'AMB')], actualPeriod: { start: visit.virtual_at }, participant: [{ actor: actorRef('practitioner_role' in item ? item.practitioner_role : item.active_practitioner_role) }] }, encounter, visit.patient_id, item === visit);
        if ('replaced_at' in item) updated = item.replaced_at;
      }
      continue;
    }
    if (type === 'Condition') {
      const revisions = reader.list(at, 'diagnosis_revisions', { encounter_id: encounter }).sort((first, second) => first.revision - second.revision);
      for (const revision of revisions) for (const diagnosis of reader.list(at, 'diagnosis_confirmations', { revision_id: revision.id })) {
        emit(clinicalFactId(encounter, diagnosis.code_system, diagnosis.code), revision.revision, revision.recorded_at, { ...context, clinicalStatus: code(`${terminology}/condition-clinical`, 'unknown'), verificationStatus: code(`${terminology}/condition-ver-status`, 'confirmed'), code: code(diagnosis.code_system, diagnosis.code), recordedDate: revision.virtual_at }, encounter, undefined, revision === revisions.at(-1));
      }
      continue;
    }
    if (type === 'Composition') {
      const revisions = reader.list(at, 'clinical_record_revisions', { encounter_id: encounter });
      const latest = Math.max(0, ...revisions.map(item => item.revision));
      for (const record of revisions) {
        const fields = z.record(z.string(), z.string()).parse(record.fields);
        const sections = Object.entries(fields).filter(([, text]) => text.trim()).map(([title, text]) => ({ title, text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${xml(text)}</div>` } }));
        emit(encounter, record.revision, record.recorded_at, { subject: [subject], encounter: context.encounter, status: record.revision === 1 ? 'final' : 'amended', type: code('http://loinc.org', '11488-4'), date: record.virtual_at, author: [actorRef(record.signed_by)], title: 'Clinical record', ...(sections.length && { section: sections }) }, encounter, undefined, record.revision === latest);
      }
      continue;
    }
    if (type === 'Observation') {
      for (const item of reader.list(at, 'encounter_triage', { encounter_id: encounter })) for (const [field, [loinc, unit]] of Object.entries(triageMeasures)) {
        const value = item.vitals[field];
        if (typeof value === 'number') emit(clinicalFactId(item.id, field), 1, item.recorded_at, { ...context, status: 'final', code: code('http://loinc.org', loinc), effectiveDateTime: item.virtual_at, valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit } }, encounter);
      }
      const assessments = reader.list(at, 'clinical_risk_assessments', { encounter_id: encounter });
      const last = Math.max(0, ...assessments.map(item => item.revision));
      for (const assessment of assessments) {
        const components = Object.entries(assessment.fields).flatMap(([key, value]) => value === null ? [] : [{ code: code(local, key), ...(typeof value === 'boolean' ? { valueBoolean: value } : typeof value === 'number' ? { valueQuantity: { value } } : { valueString: String(value) }) }]);
        emit(clinicalFactId(encounter, 'risk-assessment'), assessment.revision, assessment.recorded_at, { ...context, status: assessment.revision === 1 ? 'final' : 'amended', code: code(local, 'clinical-risk-assessment'), effectiveDateTime: assessment.virtual_at, performer: [actorRef(assessment.signed_by)], ...(components.length && { component: components }) }, encounter, undefined, assessment.revision === last);
      }
    }
    const orders = reader.list(at, 'clinical_orders', { encounter_id: encounter });
    if (type === 'Procedure') for (const stage of completedWardProcedures(reader, at, encounter)) {
      emit(stage.execution.id, 1, stage.execution.recorded_at, { ...context, status: 'completed', code: catalog.get(stage.catalogId), occurrenceDateTime: stage.execution.virtual_at, basedOn: [ref('ServiceRequest', stage.orderId)] }, encounter);
    }
    for (const order of orders) {
      const concept = catalog.get(order.catalog_item_id)!;
      if ((type === 'DiagnosticReport' || type === 'Observation') && order.kind !== 'medication') {
        const reports = reader.list(at, 'diagnostic_reports', { order_id: order.id });
        const last = Math.max(0, ...reports.map(item => item.revision));
        for (const report of reports) {
          const result = reportResult(reader, at, order.kind, report);
          if (!result) continue;
          const observations = result.observations.map(item => ({ id: clinicalFactId(order.id, item.codeSystem, item.code), item }));
          const status = 'status' in result && result.status === 'partial' ? 'partial' : 'status' in result && result.status === 'unavailable' ? 'unknown' : report.revision === 1 ? 'final' : 'corrected';
          const current = report.revision === last;
          if (type === 'DiagnosticReport') emit(order.id, report.revision, report.recorded_at, { ...context, status, code: concept, issued: report.virtual_at, performer: [actorRef(report.signed_by)], basedOn: [ref('ServiceRequest', order.id)], ...(observations.length && { result: observations.map(({ id }) => ref('Observation', `${id}/_history/${report.revision}`)) }), conclusion: result.summary.en }, encounter, undefined, current);
          else for (const { id, item } of observations) emit(id, report.revision, report.recorded_at, { ...context, status: status === 'partial' ? 'preliminary' : status, code: code(item.codeSystem, item.code), effectiveDateTime: report.virtual_at, ...(typeof item.value === 'number' ? { valueQuantity: { value: item.value, unit: item.unit } } : { valueString: item.value }), basedOn: [ref('ServiceRequest', order.id)] }, encounter, undefined, current);
        }
      } else if ((type === 'MedicationRequest' && order.kind === 'medication') || (type === 'ServiceRequest' && order.kind !== 'medication')) {
        if (reader.list(at, 'ward_incurred_orders', { order_id: order.id }).length) continue;
        const instruction = type === 'MedicationRequest' ? medicationInstruction(reader, at, order) : {};
        const states = reader.list(at, 'clinical_order_versions', { order_id: order.id }).sort((first, second) => first.version - second.version);
        let updated = order.recorded_at;
        for (const state of [...states, order]) {
          emit(order.id, state.version, updated, { ...context, authoredOn: order.virtual_at, intent: 'order', ...(order.kind === 'medication' ? { status: medicationStatus(state.status), medication: { concept }, ...instruction } : { status: serviceStatus(state.status), code: { concept } }) }, encounter, undefined, state === order);
          if ('replaced_at' in state) updated = state.replaced_at;
        }
      } else if (type === 'MedicationDispense' && order.kind === 'medication') {
        for (const delivery of wardMedicationDeliveries(reader, at, order.id)) {
          emit(delivery.id, 1, delivery.recorded_at, { ...context, status: 'completed', medication: { concept }, authorizingPrescription: [ref('MedicationRequest', order.id)], quantity: { value: delivery.quantity, unit: delivery.unit }, whenHandedOver: delivery.virtual_at }, encounter);
        }
        for (const line of reader.list(at, 'prescription_orders', { order_id: order.id })) for (const dispense of reader.list(at, 'dispenses', { prescription_order_id: line.id })) {
          emit(dispense.id, 1, dispense.recorded_at, { ...context, status: 'completed', medication: { concept }, authorizingPrescription: [ref('MedicationRequest', order.id)], quantity: { value: dispense.quantity }, whenHandedOver: dispense.virtual_at }, encounter);
        }
      } else if (type === 'Procedure') {
        for (const request of reader.list(at, 'surgery_requests', { order_id: order.id })) for (const execution of reader.list(at, 'surgery_executions', { surgery_request_id: request.id })) {
          if (reader.list(at, 'ward_surgery_stages', { request_id: request.id }).length) continue;
          emit(execution.id, 1, execution.recorded_at, { ...context, status: procedureStatus(execution.outcome), code: catalog.get(request.procedure_item_id), occurrenceDateTime: execution.virtual_at, basedOn: [ref('ServiceRequest', order.id)] }, encounter);
        }
      }
    }
  }
  return rows;
}

function procedureStatus(outcome: string) { return outcome === 'completed' ? 'completed' : ['cancelled', 'not-done'].includes(outcome) ? 'not-done' : outcome === 'started' ? 'in-progress' : 'unknown'; }
function medicationInstruction(reader: StoreReader, at: StoreScope, order: EntityRow<'clinical_orders'>) {
  const ward = wardMedicationDirections(reader, at, order);
  const direction = ward ?? reader.list(at, 'prescription_directions', { order_id: order.id })[0]?.directions;
  if (!direction) return {};
  const daily = { frequency: direction.timesPerDay, period: 1, periodUnit: 'd' };
  const prn = ward?.frequency === 'PRN';
  const timing = { ...(ward && { code: { text: ward.frequency } }), ...(!prn && { repeat: ward?.frequency === 'ONCE' ? { count: 1 } : daily }) };
  return { dosageInstruction: [{ timing, ...(prn && { asNeeded: true }), route: { text: direction.routeCode }, doseAndRate: [{ doseQuantity: { value: direction.dose, unit: direction.doseUnit } }] }] };
}
function reportResult(reader: StoreReader, at: StoreScope, kind: string, report: EntityRow<'diagnostic_reports'>) {
  const { findings } = report;
  if (kind === 'examination') {
    const angiography = signedAngiography(reader, at, report);
    if (angiography) return { ...angiography, summary: angiography.summary ?? { en: 'Measurements unavailable' } };
  }
  if (kind === 'imaging' || kind === 'pathology') {
    const sections = studyReportSectionsSchema.safeParse(findings.sections).data;
    if (sections?.kind === 'summary') return { observations: [], summary: sections.summary };
    if (sections?.kind === 'imaging' && kind === 'imaging') return { observations: [], summary: { en: `${sections.findings.en}\n${sections.impression.en}` } };
    if (sections?.kind === 'pathology' && kind === 'pathology') return { observations: [], summary: { en: `${sections.microscopy.en}\n${sections.diagnosis.en}` } };
  }
  return signedFindingsSchema.safeParse(findings).data;
}
function auditOutcome(value: string) {
  const codes: Record<string, string> = { applied: '0', accepted: '0', reported: '0', completed: '0', 'generation-failed': '8', failed: '8', rejected: '8' };
  const outcome = Object.hasOwn(codes, value) ? { system: `${terminology}/audit-event-outcome`, code: codes[value] } : { system: `${local}:audit-outcome`, code: 'recorded' };
  return { outcome: { code: outcome, detail: [{ text: value }] } };
}
function xml(text: string) { return Array.from(text).filter(char => char >= ' ' || ['\t', '\r', '\n'].includes(char)).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
