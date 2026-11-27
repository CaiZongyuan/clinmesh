import { z } from 'zod';
import { ageOn, clinicalFactId, clinicalFactSystem, triageMeasures } from '../../clinical-core';
import { catalogSchema, knowledgeSchema, readClinicalCase, type Coding } from '../../data-pack';
import { signedFindingsSchema } from '../../mod-lab';
import { signedAngiography } from '../../mod-inpatient';
import { requireEncounter } from '../../patient-visit';
import { CoreError, type ReadContext } from '../../platform';
import type { EntityRow, StoreReader, StoreScope } from '../../store';
import { killipClassSchema, priorBleedingHistorySchema, smokingStatusSchema, type ClinicalScoreSourceReference } from './score-contracts';
import { evaluateClinicalScores, type ClinicalScoreObjectiveFacts } from './scores';

export const bedsideFields = z.strictObject({
  killipClass: killipClassSchema, cardiacArrestOnAdmission: z.boolean(), stSegmentDeviation: z.boolean(),
  anginaEpisodes24h: z.int().min(0).max(100), aspirinUsedLast7Days: z.boolean(), familyHistoryPrematureCad: z.boolean(),
  knownCoronaryRevascularizationOrStenosisGe50: z.boolean(), priorBleedingHistory: priorBleedingHistorySchema, smokingStatus: smokingStatusSchema,
  pciDaptIndication: z.boolean(), priorCoronaryRevascularization: z.boolean(), cadOnsetAgeYears: z.int().min(0).max(120), severeAscvdEventCount: z.int().min(0).max(100),
  hypertensionHistory: z.boolean(), diabetesHistory: z.boolean(), dyslipidemiaHistory: z.boolean(),
  ckdLt30Chronicity: z.enum(['confirmed', 'excluded']), ckdLt60Chronicity: z.enum(['confirmed', 'excluded']),
  weightKg: z.number().min(1).max(400), heightCm: z.number().min(30).max(260), acuteChestPain: z.boolean(),
}).partial();
export const sameCoding = (first: Coding, second: Coding) => first.code === second.code && first.codeSystem === second.codeSystem;
export const catalogCoding = (row: EntityRow<'catalog_items'>) => ({ code: row.code, codeSystem: row.code_system });
const loinc = 'http://loinc.org';
const measures = { serumCreatinine: ['2160-0', '14682-9'], hemoglobin: ['718-7'], wbc: ['6690-2', '26464-8'],
  totalCholesterol: ['2093-3', '14647-2'], hdlCholesterol: ['2085-9', '14646-4'], ldlCholesterol: ['2089-1', '13457-7', '22748-8'],
  troponin: ['89579-7', '67151-1', '6598-7', '10839-9', '49563-0'], egfr: ['98979-8', '33914-3', '62238-1'] };
type Measurement = Coding & { unit: string; value: string | number | boolean; observedAt: string; source: ClinicalScoreSourceReference; interpretation?: string };
const evidenceCoding = z.strictObject({ codeSystem: z.url(), code: z.string().min(1) });
export const legacyEcgSchema = z.array(z.strictObject({ packId: z.string(), packVersions: z.array(z.string()).nonempty(), ecg: evidenceCoding, diagnosticSystems: z.array(z.url()).optional(), topicEvidence: z.record(z.string(), z.array(evidenceCoding)) }));
export type LegacyEcg = z.infer<typeof legacyEcgSchema>;
const sourced = <Value>(value: Value, source: ClinicalScoreSourceReference) => ({ value, source });
const reference = (label: string, reference: string, version: number | string) => ({ label, reference, versionId: String(version) });
const byTime = (first: { virtual_at: string; id: string }, second: { virtual_at: string; id: string }) => Date.parse(first.virtual_at) - Date.parse(second.virtual_at) || first.id.localeCompare(second.id);

export function authorizedFacts({ reader, actor, targetId }: ReadContext, legacy: LegacyEcg) {
  const encounter = requireEncounter(reader, actor.at, targetId);
  if (encounter.active_practitioner_role !== actor.role.id) throw new CoreError(403, 'RESPONSIBLE_ROLE_REQUIRED');
  return clinicalFacts(reader, actor.at, encounter.id, legacy);
}

export function clinicalFacts(reader: StoreReader, at: StoreScope, encounterId: string, legacy: LegacyEcg) {
  const encounter = requireEncounter(reader, at, encounterId);
  const patient = reader.get(at, 'patients', encounter.patient_id)!;
  const caseView = readClinicalCase(reader, at, encounter.source_case_id)!;
  const pack = reader.list(at, 'data_pack_installations')[0]!;
  const knowledge = knowledgeSchema.parse({ guidelineTopics: [], orderSetTemplates: [], ...pack.knowledge });
  const end = encounter.status === 'completed' ? reader.list(at, 'audit_events', { target_id: encounterId, operation: 'encounter.complete' })[0]?.virtual_at : undefined;
  const now = end ?? reader.getEpoch(at)!.virtual_time;
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: z.string().parse(pack.manifest.timezone), year: 'numeric', month: '2-digit', day: '2-digit' });
  const age = patient.birth_date && ageOn(patient.birth_date, calendar.format(new Date(now)));
  const triage = reader.list(at, 'encounter_triage', { encounter_id: encounterId })[0];
  const assessment = reader.list(at, 'clinical_risk_assessments', { encounter_id: encounterId }).sort((first, second) => second.revision - first.revision)[0];
  const bedside = bedsideFields.parse(assessment?.fields ?? {});
  const confirmed = reader.list(at, 'diagnosis_revisions', { encounter_id: encounterId }).sort((first, second) => second.revision - first.revision)[0];
  const diagnoses = confirmed ? reader.list(at, 'diagnosis_confirmations', { revision_id: confirmed.id }).map(item => ({ codeSystem: item.code_system, code: item.code })) : [];
  const historical = legacy.find(entry => entry.packId === pack.pack_id && entry.packVersions.includes(pack.pack_version));
  const diagnosticSystems = knowledge.cds?.diagnosticSystems ?? historical?.diagnosticSystems ?? ['http://hl7.org/fhir/sid/icd-10'];
  const historyRef = reference('Prior History', `ClinicalCase/${caseView.id}/prior-history`, pack.pack_version);
  const codes = diagnoses.filter(item => diagnosticSystems.includes(item.codeSystem)).map(item => item.code.toUpperCase());
  const catalog = reader.list(at, 'catalog_items');
  const byId = new Map(catalog.map(item => [item.id, item]));
  const orders = reader.list(at, 'clinical_orders', { encounter_id: encounterId });
  const reports = orders.flatMap(order => {
    const item = byId.get(order.catalog_item_id)!;
    const service = item.kind === 'services' ? catalogSchema.shape.services.element.parse(item.definition) : undefined;
    const revisions = reader.list(at, 'diagnostic_reports', { order_id: order.id }).filter(row => Date.parse(row.virtual_at) <= Date.parse(now)).sort((first, second) => first.revision - second.revision);
    const latest = revisions.at(-1);
    if (!latest || !service) return [];
    const functional = signedFindingsSchema.safeParse(latest.findings).data;
    const coronary = functional ? undefined : signedAngiography(reader, at, latest);
    const findings = functional ?? (coronary && coronary.status !== 'unavailable' ? { observations: coronary.observations, stSegmentDeviation: undefined } : undefined);
    return findings ? [{ orderId: order.id, service, first: revisions[0]!, latest, findings, source: reference(service.display.en, `DiagnosticReport/${order.id}`, latest.revision) }] : [];
  }).sort((first, second) => byTime(first.first, second.first));
  const observed: Measurement[] = [
    ...caseView.priorHistory.observations.filter(item => Date.parse(item.observedAt) <= Date.parse(now)).map(item => ({ ...item.analyte, value: item.value, unit: item.unit, observedAt: item.observedAt, source: historyRef })),
    ...reports.flatMap(report => report.findings.observations.map(item => ({ ...item, observedAt: report.first.virtual_at, source: reference(item.display.en, `Observation/${clinicalFactId(report.orderId, item.codeSystem, item.code)}`, report.latest.revision) }))),
  ].sort((first, second) => Date.parse(first.observedAt) - Date.parse(second.observedAt));
  const matched = (name: keyof typeof measures) => observed.filter(item => item.codeSystem === loinc && measures[name].includes(item.code));
  const quantity = (item?: Measurement) => item && typeof item.value === 'number' ? sourced({ unit: item.unit, value: item.value }, item.source) : undefined;
  const facts: ClinicalScoreObjectiveFacts = { confirmedDiagnoses: [
    ...diagnoses.filter(item => diagnosticSystems.includes(item.codeSystem)).map(item => ({ code: item.code, source: reference('Confirmed diagnosis', `Condition/${clinicalFactId(encounterId, item.codeSystem, item.code)}`, confirmed!.revision) })),
    ...caseView.priorHistory.diagnoses.filter(item => diagnosticSystems.includes(item.codeSystem)).map(item => ({ code: item.code, context: 'history' as const, source: historyRef })),
  ] };
  if (typeof age === 'number') facts.ageYears = sourced(age, reference('Patient identity', `Patient/${patient.id}`, patient.version));
  if (caseView.demographics.sex === 'male' || caseView.demographics.sex === 'female') facts.sex = sourced(caseView.demographics.sex, reference('Sex at registration', `Patient/${patient.id}`, patient.version));
  if (triage) {
    const vitals = z.object({ heartRateBpm: z.number(), systolicMmHg: z.number(), diastolicMmHg: z.number() }).parse(triage.vitals);
    const source = (field: string) => reference(field, `Observation/${clinicalFactId(triage.id, field)}`, 1);
    facts.heartRateBpm = sourced(vitals.heartRateBpm, source('heartRateBpm'));
    facts.systolicBpMmHg = sourced(vitals.systolicMmHg, source('systolicMmHg'));
    facts.diastolicBpMmHg = sourced(vitals.diastolicMmHg, source('diastolicMmHg'));
    for (const [field, [code, unit]] of Object.entries(triageMeasures)) {
      const value = triage.vitals[field];
      if (typeof value === 'number') observed.push({ codeSystem: loinc, code, value, unit, observedAt: triage.virtual_at, source: source(field) });
    }
  }
  if (assessment) {
    const source = reference('Bedside risk assessment', `Observation/${clinicalFactId(encounterId, 'risk-assessment')}`, assessment.revision);
    Object.assign(facts, Object.fromEntries(Object.entries(bedside).map(([key, value]) => [key, sourced(value, source)])));
    for (const [code, value] of Object.entries(bedside)) if (code !== 'stSegmentDeviation') observed.push({ codeSystem: clinicalFactSystem, code, value, unit: code === 'weightKg' ? 'kg' : code === 'heightCm' ? 'cm' : '1', observedAt: assessment.virtual_at, source });
  }
  for (const name of ['serumCreatinine', 'hemoglobin', 'wbc', 'ldlCholesterol', 'hdlCholesterol', 'totalCholesterol'] as const) facts[name] = quantity(matched(name).at(-1));
  const firstCurrent = (name: keyof typeof measures) => quantity(matched(name).find(item => item.source.reference.startsWith('Observation/')));
  facts.admissionSerumCreatinine = firstCurrent('serumCreatinine') ?? null;
  facts.baselineHemoglobin = firstCurrent('hemoglobin') ?? null;
  facts.baselineWbc = firstCurrent('wbc') ?? null;
  const firstEcg = reports.find(report => report.service.modality === 'ecg-12-lead' || (!report.service.modality && historical && sameCoding(historical.ecg, report.service)));
  if (firstEcg?.findings.stSegmentDeviation !== undefined) facts.stSegmentDeviation = sourced(firstEcg.findings.stSegmentDeviation, firstEcg.source);
  if (facts.stSegmentDeviation?.source) observed.push({ codeSystem: clinicalFactSystem, code: 'stSegmentDeviation', value: facts.stSegmentDeviation.value, unit: '1', observedAt: firstEcg?.findings.stSegmentDeviation !== undefined ? firstEcg.latest.virtual_at : assessment!.virtual_at, source: facts.stSegmentDeviation.source });
  const biomarker = matched('troponin').find(item => item.interpretation && item.source.reference.startsWith('Observation/'));
  if (biomarker && ['high', 'normal', 'low'].includes(biomarker.interpretation!)) facts.elevatedCardiacBiomarker = sourced(biomarker.interpretation === 'high', biomarker.source);
  const scores = evaluateClinicalScores(facts);
  const currentCreatinine = matched('serumCreatinine').at(-1);
  const measuredEgfr = matched('egfr').at(-1);
  const egfr = measuredEgfr && (!currentCreatinine || Date.parse(measuredEgfr.observedAt) >= Date.parse(currentCreatinine.observedAt)) && typeof measuredEgfr.value === 'number' && /^mL\/min\/1\.73\s*m(?:2|²|\^2)$/i.test(measuredEgfr.unit) ? measuredEgfr.value : scores[0]!.value;
  return { encounter, patient, age, pack, now, bedside, assessment, codes, catalog, byId, orders, reports, observed, facts, scores, firstEcg, biomarker, currentCreatinine, egfr, knowledge, caseView, diagnoses, historical };
}
export type ClinicalFacts = ReturnType<typeof clinicalFacts>;
