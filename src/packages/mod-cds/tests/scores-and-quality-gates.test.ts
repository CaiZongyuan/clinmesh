import { v7 } from 'uuid';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { cdsWorkspace } from '../../../server/testing/cds-workspace';
import { builtinModules } from '../../../server/builtin-modules';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseHospitalDataPack } from '../../data-pack';
import { canonicalJson } from '../../store';
import { labViewSchema, issueReceipt } from '../../mod-lab';
import type { ClinMeshModule, OperationCatalog } from '../../platform';
import { calculateAscvdLdlTarget, calculateCkdEpi2021Egfr, calculateCockcroftGaultCrCl, calculateGraceAcs, calculatePreciseDapt, calculateTimiUaNstemi, evaluateClinicalScores, guidelinesSchema, orderSetsSchema, scoreViewSchema } from '../index';

it('calculates the reference clearance and reports every absent required input', () => {
  expect(calculateCockcroftGaultCrCl({ ageYears: 68, sex: 'female', weightKg: 72, serumCreatinine: { value: 88.4, unit: 'µmol/L' } }).value).toBe(61.2);
  const scores = evaluateClinicalScores({ confirmedDiagnoses: [] });
  expect(scores).toHaveLength(6);
  expect(scores.every(score => score.status === 'incomplete' && score.missingInputs.length > 0)).toBe(true);
  expect(scores[0]?.missingInputs).toEqual(['age', 'sex', 'serumCreatinine']);
});

it('matches calibrated renal, ischemic, bleeding and lipid targets in conventional and SI units', () => {
  const creatinine = { unit: 'mg/dL', value: 1 };
  expect(calculateCkdEpi2021Egfr({ ageYears: 60, sex: 'male', serumCreatinine: creatinine }).value).toBe(86.2);
  expect(calculateCkdEpi2021Egfr({ ageYears: 60, sex: 'male', serumCreatinine: { unit: 'μmol/L', value: 88.4 } }).value).toBe(86.2);
  expect(calculateGraceAcs({ ageYears: 66, serumCreatinine: creatinine, heartRateBpm: 88, systolicBpMmHg: 132, killipClass: 'I', cardiacArrestOnAdmission: false, stSegmentDeviation: false, elevatedCardiacBiomarker: true }).value).toBe(122);
  expect(calculateTimiUaNstemi({ ageYears: 70, anginaEpisodes24h: 3, aspirinUsedLast7Days: true, cadRiskFactorCount: 3, elevatedCardiacBiomarker: true, knownCoronaryStenosisGe50Pct: true, stSegmentDeviation: true }).value).toBe(7);
  const precise = { ageYears: 56, creatinineClearanceMlMin: 88, priorBleedingHistory: 'negative' as const };
  expect(calculatePreciseDapt({ ...precise, hemoglobin: { value: 142, unit: 'g/L' }, wbc: { value: 6.8, unit: '10*9/L' } }).value).toBe(8);
  expect(calculatePreciseDapt({ ...precise, hemoglobin: { value: 14.2, unit: 'g/dL' }, wbc: { value: 6800, unit: '/µL' } }).value).toBe(8);
  expect(calculateAscvdLdlTarget({ ageYears: 66, confirmedDiagnosisCodes: ['I21.4'], severeAscvdEventCount: 2, ldlCholesterol: { unit: 'mg/dL', value: 38.67 } })).toMatchObject({ status: 'complete', value: 1.4 });
});

const dose = { codeSystem: 'urn:clinmesh:general:drug', code: 'doxycycline', dose: 100, routeCode: 'PO', timesPerDay: 1, days: 1, quantity: 1 };
const override = (rule: string) => ({ reasonCode: 'specialist-judgment', note: 'Outside bacterial test reviewed with the patient.', ruleCodes: [rule] });

it('requires current ACS presentation and counts distinct severe events rather than overlapping diagnosis codings', async () => {
  const host = await cdsWorkspace(pack => pack.cases[0]!.priorHistory.diagnoses.push({ codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'I21.4' }));
  try {
    const path = await host.start('Avery Reed', 'J18.9');
    const { scores } = scoreViewSchema.parse(await host.get(`${path}/cds/scores`));
    expect(scores.find(item => item.id === 'grace-acs')?.missingInputs).toContain('acsPresentation');
    expect(scores.find(item => item.id === 'timi-ua-nstemi')?.missingInputs).toContain('uaNstemiPresentation');
  } finally { await host.store.close(); }
  const ambiguous = calculateAscvdLdlTarget({ ageYears: 75, confirmedDiagnosisCodes: ['I21.4', 'I21.4'] });
  expect(ambiguous).toMatchObject({ status: 'incomplete', missingInputs: expect.arrayContaining(['severeAscvdEventCount']) });
  expect(calculateAscvdLdlTarget({ ageYears: 75, confirmedDiagnosisCodes: ['I25.1'] })).toMatchObject({ status: 'incomplete', missingInputs: expect.arrayContaining(['severeAscvdEventCount']) });
  const primary = { ageYears: 62, sex: 'female' as const, smokingStatus: 'never' as const, egfrMlMin173m2: 93, systolicBpMmHg: 119, diastolicBpMmHg: 76, ldlCholesterol: { unit: 'mmol/L', value: 2.1 }, hdlCholesterol: { unit: 'mmol/L', value: 1.6 }, confirmedDiagnosisCodes: [], priorCoronaryRevascularization: false };
  expect(calculateAscvdLdlTarget(primary)).toMatchObject({ status: 'incomplete', missingInputs: expect.arrayContaining(['diabetesHistory']) });
  expect(calculateAscvdLdlTarget({ ...primary, diabetesHistory: false, hypertensionHistory: false })).toMatchObject({ status: 'complete', tierCode: 'low' });
});

it('rejects WBC mass concentration and accepts equivalent cell-count units for PRECISE-DAPT', () => {
  const inputs = { ageYears: { value: 62 }, sex: { value: 'female' as const }, weightKg: { value: 70 }, serumCreatinine: { value: { value: 1, unit: 'mg/dL' } }, hemoglobin: { value: { value: 13, unit: 'g/dL' } }, priorBleedingHistory: { value: 'negative' as const }, pciDaptIndication: { value: true }, confirmedDiagnoses: [] };
  const score = (value: number, unit: string) => evaluateClinicalScores({ ...inputs, wbc: { value: { value, unit } } }).find(item => item.id === 'precise-dapt');
  expect(score(6.8, 'g/L')).toMatchObject({ status: 'incomplete', missingInputs: ['wbc'] });
  expect(score(6.8, '×10^9/L')).toMatchObject({ status: 'complete' });
  expect(score(6.8, '×10^9/L')).toEqual(score(6800, '/µL'));
});

it('completes the frozen global-general 1.3.0 chest-pain encounter after both paid reports are signed and acknowledged', async () => {
  const archived = readFileSync(new URL('./fixtures/cc914872-general-v1.3.0.json.gz.b64', import.meta.url), 'utf8');
  const pack = parseHospitalDataPack(JSON.parse(gunzipSync(Buffer.from(archived, 'base64')).toString()));
  expect(createHash('sha256').update(canonicalJson(pack)).digest('hex')).toBe('5d82796c5987c32f0529d1e5c453a00ae68737b943526be659d1441cc67b1207');
  const host = await cdsWorkspace(undefined, builtinModules, pack);
  try {
    const path = await host.start('Jordan Vale', 'I21.4');
    const lab = () => host.get(`${path}/lab`).then(value => labViewSchema.parse(value));
    const serviceIds = (await lab()).services.filter(service => ['ecg12', 'hs-tni'].includes(service.code)).map(item => item.id);
    await host.applied(host.command(`${path}/lab/draft`, 0, { serviceIds }, 'PUT'));
    const issued = issueReceipt.parse(await host.applied(host.command(`${path}/lab/issue`, 1, { items: (await lab()).draft.items })));
    expect(issued.results).toHaveLength(2);
    await host.role('cashier');
    for (const entry of issued.results) {
      if (!('orderId' in entry)) throw Error(entry.error);
      await host.collect(path, entry.orderId);
    }
    await host.role('family-clinician');
    for (const order of (await lab()).orders) {
      for (const [index, action] of ['accept', 'start', 'report-now'].entries()) await host.applied(host.command(`/api/his/lab/orders/${order.id}/${action}`, index + 1));
      const signed = (await lab()).orders.find(item => item.id === order.id)!;
      await host.applied(host.command(`/api/his/reports/${signed.reports[0]!.id}/acknowledge`, signed.version, { reportVersion: 1 }));
    }
    await host.applied(host.command(`${path}/no-medication`, 5, { reason: 'Reviewed decision for this visit.' }));
    expect(await host.get(`${path}/completion`)).toMatchObject({ ready: true });
    expect(await host.applied(host.command(`${path}/complete`, 6))).toMatchObject({ version: 7 });
  } finally { await host.store.close(); }
});

it('returns only topic-specific missing inputs and links each triage, bedside and report observation to its revision', async () => {
  const host = await cdsWorkspace(pack => {
    const topics = pack.knowledge!.guidelineTopics;
    topics.push({ ...topics[0]!, id: 'blood-pressure', evidence: [{ codeSystem: 'http://loinc.org', code: '8462-4' }] });
  });
  try {
    const path = await host.start('Jordan Vale', 'I21.4');
    const get = () => host.get(`${path}/cds/guidelines`).then(value => guidelinesSchema.parse(value));
    const { topics } = await get();
    expect(topics[0]!.missingInputs).toEqual(['http://loinc.org|89579-7', 'urn:clinmesh:clinical|stSegmentDeviation']);
    expect(topics[1]!.observations.map(item => item.code)).toEqual(['8462-4']);
    expect(topics[1]!.missingInputs).toEqual([]);
    await host.applied(host.command(`${path}/cds/risk-assessment`, 5, { expectedRevision: 0, fields: { stSegmentDeviation: true, killipClass: 'I' } }));
    const visit = path.split('/').at(-1)!;
    await host.store.withTransaction(tx => {
      const service = tx.list(host.at, 'catalog_items', { kind: 'services', code: 'hs-tni' })[0]!;
      const orderId = v7(), times = { virtual_at: host.now, recorded_at: host.now };
      tx.insert(host.at, 'clinical_orders', { id: orderId, encounter_id: visit, catalog_item_id: service.id, kind: 'lab', status: 'reported', version: 1, ...times });
      tx.insert(host.at, 'diagnostic_reports', { id: v7(), order_id: orderId, revision: 1, previous_revision_id: null, signed_by: 'lab', ...times, findings: { summary: { en: 'Troponin', zh: '肌钙蛋白' }, observations: [{ codeSystem: 'http://loinc.org', code: '89579-7', display: { en: 'Troponin', zh: '肌钙蛋白' }, value: 51, unit: 'ng/L', interpretation: 'high', critical: false }] } });
    });
    const complete = await get();
    expect(complete.topics[0]!.missingInputs).toEqual([]);
    for (const observation of complete.observations) {
      const { reference, versionId } = observation.source;
      expect(await host.get(`/fhir/R5/${reference}/_history/${versionId}`)).toMatchObject({ resourceType: 'Observation', meta: { versionId } });
    }
  } finally { await host.store.close(); }
});

it('distinguishes missing creatinine, proven renal contraindication and dosage limits inside the signed command', async () => {
  const host = await cdsWorkspace(pack => {
    const drug = pack.catalog.medications.find(item => item.code === 'metformin')!;
    drug.safety.indicationPrefixes = ['E11'];
  });
  try {
    const path = await host.start('Morgan Pine', 'E11.9');
    const encounterId = path.split('/').at(-1)!;
    const sign = (doseAmount: number, rule: string) => host.command(`${path}/prescriptions`, 5, { lines: [{ ...dose, code: 'metformin', dose: doseAmount }], clinicalOverride: override(rule) });
    expect(await (await sign(500, 'UNKNOWN')).json()).toMatchObject({ code: 'CLINICAL_QUALITY_ALERT', details: { ruleCodes: 'RENAL_CREATININE_MISSING' } });
    expect(await (await sign(2000, 'MEDICATION_DOSE_LIMIT_EXCEEDED')).json()).toMatchObject({ code: 'CLINICAL_QUALITY_RED_LINE', details: { ruleCodes: 'MEDICATION_DOSE_LIMIT_EXCEEDED' } });
    await host.store.withTransaction(tx => {
      const lab = tx.list(host.at, 'catalog_items', { kind: 'services', code: 'egfr' })[0]!;
      const orderId = v7();
      const times = { virtual_at: host.now, recorded_at: host.now };
      tx.insert(host.at, 'clinical_orders', { id: orderId, encounter_id: encounterId, catalog_item_id: lab.id, kind: 'lab', status: 'reported', version: 1, ...times });
      tx.insert(host.at, 'diagnostic_reports', { id: v7(), order_id: orderId, revision: 1, previous_revision_id: null, signed_by: 'lab', ...times, findings: { summary: { en: 'Renal impairment', zh: '肾功能异常' }, observations: [{ codeSystem: 'http://loinc.org', code: '98979-8', display: { en: 'eGFR', zh: '肾小球滤过率' }, unit: 'mL/min/1.73m2', value: 29, interpretation: 'low', critical: false }] } });
    });
    const before = await host.store.exportLogicalSnapshot(host.at.workspaceId);
    const response = await sign(500, 'RENAL_CONTRAINDICATED_MEDICATION');
    expect([response.status, await response.json()]).toEqual([409, { code: 'CLINICAL_QUALITY_RED_LINE', details: { ruleCodes: 'RENAL_CONTRAINDICATED_MEDICATION' } }]);
    expect(await host.store.exportLogicalSnapshot(host.at.workspaceId)).toEqual(before);
  } finally { await host.store.close(); }
});

it('passes transaction-sourced PCI and discharge intents through the registered cross-module quality gate', async () => {
  const caller: ClinMeshModule<OperationCatalog> = { id: 'example-inpatient', kind: 'clinical', version: '1', registerOperations(catalog) {
    catalog.command({ name: 'example.decision', path: '/api/example/:id/decision', method: 'POST', access: { capabilities: ['sign'], visitorOnly: true } }, { kind: z.enum(['pci', 'discharge']), clinicalOverride: z.unknown().optional() }, z.object({ applied: z.boolean() }), (context, input) => {
      context.checkClinicalQuality?.(input.kind === 'pci' ? { kind: 'pci', encounterId: context.targetId, ffr: 0.86 } : { kind: 'discharge', encounterId: context.targetId, completedPci: true, activeMedicationIds: [] }, input.clinicalOverride);
      return { applied: true };
    });
  } };
  const host = await cdsWorkspace(pack => pack.manifest.enabledModules.push(caller.id), [...builtinModules, caller]);
  try {
    const encounter = (await host.start('Avery Reed', 'J18.9')).split('/').at(-1)!;
    const action = (kind: string, clinicalOverride?: unknown) => host.command(`/api/example/${encounter}/decision`, 5, { kind, clinicalOverride });
    expect(await (await action('pci')).json()).toMatchObject({ code: 'CLINICAL_QUALITY_ALERT', details: { ruleCodes: 'PCI_NON_ISCHEMIC_LESION' } });
    expect(await host.applied(action('pci', override('PCI_NON_ISCHEMIC_LESION')))).toEqual({ applied: true });
    const codes = ['DISCHARGE_ANTIPLATELET_MISSING', 'DISCHARGE_STATIN_MISSING'];
    expect(await (await action('discharge', override(codes[0]!))).json()).toMatchObject({ code: 'CLINICAL_QUALITY_ALERT', details: { ruleCodes: codes.join(',') } });
    expect(await host.applied(action('discharge', { ...override(codes[0]!), ruleCodes: codes }))).toEqual({ applied: true });
  } finally { await host.store.close(); }
});

it('isolates bedside revisions, first signed ECG and age-qualified verbatim guidance from callers and drafts', async () => {
  const host = await cdsWorkspace(pack => {
    const topics = pack.knowledge!.guidelineTopics;
    topics.push({ ...topics[0]!, id: 'children', population: 'pediatric' }, { ...topics[0]!, id: 'everyone', population: 'all' });
    pack.cases[0]!.demographics.birthDate = '2008-06-11';
  });
  try {
    const path = await host.start('Avery Reed', 'J18.9');
    const id = path.split('/').at(-1)!;
    const score = () => host.get(`${path}/cds/scores`).then(value => scoreViewSchema.parse(value));
    const topics = () => host.get(`${path}/cds/guidelines`).then(value => guidelinesSchema.parse(value));
    expect((await topics()).topics.map(item => item.id)).toEqual(['children', 'everyone']);
    await host.store.withTransaction(tx => tx.updateEpoch(host.at, 0, { virtual_time: '2026-06-11T00:00:00.000Z' }));
    expect((await topics()).topics.map(item => item.id)).toEqual(['acute-chest-pain-troponin', 'everyone']);
    expect((await host.fetchApi(`${path}/cds/scores?serumCreatinine=8`)).status).toBe(400);
    await host.applied(host.command(`${path}/cds/risk-assessment`, 5, { expectedRevision: 0, fields: { stSegmentDeviation: false, killipClass: 'I' } }));
    expect(await score()).toMatchObject({ revision: 1, effectiveStSegmentDeviation: false });
    await host.store.withTransaction(tx => {
      const service = tx.list(host.at, 'catalog_items', { kind: 'services', code: 'ecg12' })[0]!;
      for (const [date, st] of [['2026-06-10T12:00:00.000Z', true], ['2026-06-10T13:00:00.000Z', false]] as const) {
        const order = v7();
        tx.insert(host.at, 'clinical_orders', { id: order, encounter_id: id, kind: 'examination', catalog_item_id: service.id, status: 'reported', version: 1, virtual_at: date, recorded_at: date });
        tx.insert(host.at, 'diagnostic_reports', { id: v7(), revision: 1, previous_revision_id: null, order_id: order, signed_by: 'lab', findings: { summary: { en: 'ECG', zh: '心电' }, stSegmentDeviation: st, observations: [] }, virtual_at: date, recorded_at: date });
      }
    });
    await host.applied(host.command(`${path}/cds/risk-assessment`, 6, { expectedRevision: 1, fields: { stSegmentDeviation: false } }));
    expect(await score()).toMatchObject({ revision: 2, effectiveStSegmentDeviation: true, stSource: expect.stringMatching(/^DiagnosticReport\//) });
    expect((await host.command(`${path}/cds/risk-assessment`, 7, { expectedRevision: 1, fields: {} })).status).toBe(409);
  } finally { await host.store.close(); }
});

it('pre-screens catalog members without writes and rejects hard contraindications before accepting any override', async () => {
  const host = await cdsWorkspace(pack => {
    const template = pack.knowledge!.orderSetTemplates[0]!;
    for (const code of ['amoxicillin', 'metformin']) template.members.push({ kind: 'medications', codeSystem: dose.codeSystem, code });
  });
  try {
    const path = await host.start('Avery Reed', 'J18.9');
    const baseline = await host.store.exportLogicalSnapshot(host.at.workspaceId);
    const [template] = orderSetsSchema.parse(await host.get(`${path}/cds/order-sets`));
    expect(template?.members.map(item => [item.code, item.status])).toEqual([['ecg12', 'ready'], ['hs-tni', 'ready'], ['amoxicillin', 'excluded'], ['metformin', 'needs-review']]);
    const red = await host.command(`${path}/prescriptions`, 5, { lines: [{ ...dose, code: 'amoxicillin', dose: 500 }], clinicalOverride: override('MEDICATION_ALLERGY_CONFLICT') });
    expect([red.status, await red.json()]).toEqual([409, { code: 'CLINICAL_QUALITY_RED_LINE', details: { ruleCodes: 'MEDICATION_ALLERGY_CONFLICT' } }]);
    expect(await host.store.exportLogicalSnapshot(host.at.workspaceId)).toEqual(baseline);
  } finally { await host.store.close(); }
});

it('commits valid pathway exceptions, audit, receipt and prescription atomically, including replay', async () => {
  const host = await cdsWorkspace();
  try {
    const path = await host.start('Riley Dale', 'J06.9');
    const fields = { lines: [dose] };
    const baseline = await host.store.exportLogicalSnapshot(host.at.workspaceId);
    for (const invalid of [undefined, { ...override('ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION'), reasonCode: 'anything' }, override('UNKNOWN')]) {
      const response = await host.command(`${path}/prescriptions`, 5, { ...fields, clinicalOverride: invalid });
      expect([response.status, await response.json()]).toEqual([409, { code: 'CLINICAL_QUALITY_ALERT', details: { ruleCodes: 'ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION' } }]);
    }
    expect(await host.store.exportLogicalSnapshot(host.at.workspaceId)).toEqual(baseline);
    const reason = override('ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION');
    const idempotencyKey = crypto.randomUUID();
    const sign = () => host.command(`${path}/prescriptions`, 5, { ...fields, clinicalOverride: reason }, 'POST', idempotencyKey);
    const receipt = z.object({ prescriptionId: z.uuidv7() }).parse(await host.applied(sign()));
    expect(await host.applied(sign())).toMatchObject(receipt);
    await host.store.read(reader => {
      const overrides = reader.list(host.at, 'clinical_overrides');
      expect(overrides).toMatchObject([{ rule_code: reason.ruleCodes[0], rationale: reason.note }]);
      const [detail] = reader.list(host.at, 'clinical_override_reasons');
      expect(detail).toMatchObject({ id: overrides[0]!.id, reason_code: reason.reasonCode, command_name: 'prescription.sign' });
      expect(reader.get(host.at, 'audit_events', detail!.audit_id)).toMatchObject({ operation: 'clinical.override', target_id: detail!.id, practitioner_role: 'family-clinician' });
      expect(reader.findCommandReceipt(host.at, idempotencyKey)?.result).toMatchObject(receipt);
      expect(reader.list(host.at, 'charge_sources')).toHaveLength(1);
    });
  } finally { await host.store.close(); }
});
