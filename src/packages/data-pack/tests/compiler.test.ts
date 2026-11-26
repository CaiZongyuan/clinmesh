import { expect, it } from 'vitest';
import { BUILTIN_DATA_PACKS } from '../../../server/builtin-data-packs';
import { stringify } from 'yaml';
import { findCatalogItem, parseHospitalDataPack, type HospitalDataPack } from '../index';

it('rejects a Hospital Data Pack missing its five-layer contract', () => {
  expect(() => parseHospitalDataPack({ manifest: { schemaVersion: 1 } })).toThrowError(
    expect.objectContaining({ code: 'INVALID_PACK' }),
  );
});

const general = () => structuredClone(BUILTIN_DATA_PACKS['global-general']);

it('loads the authored coronary angiography, negative FFR and stent selection teaching paths', () => {
  const pack = parseHospitalDataPack(BUILTIN_DATA_PACKS['cn-cardiology']);
  expect(pack.catalog.medications).toHaveLength(22);
  expect(pack.manifest.enabledModules).toEqual(expect.arrayContaining(['mod-inpatient', 'mod-drg-cn']));
  const [intervention, conservative] = pack.cases;
  expect(intervention?.caseTruth.expectedMaterials?.map(item => item.code)).toContain('des-3x18');
  expect(conservative?.caseTruth.expectedMaterials).toEqual([]);
  const findings = conservative?.caseTruth.results.find(item => item.service.code === 'cag')?.observations;
  expect(findings).toContainEqual({ analyte: { codeSystem: 'urn:clinmesh:cv:measurement', code: 'LAD-FFR' }, value: 0.86 });
  expect(intervention?.caseTruth.results.map(item => item.stage)).toEqual(expect.arrayContaining(['initial', 'inpatient', 'repeat', 'follow-up']));
  const stent = findCatalogItem(pack, 'materials', { codeSystem: 'urn:clinmesh:cv:material', code: 'des-3x18' });
  expect(stent).toMatchObject({ diameterMm: 3, lengthMm: 18 });
  expect(pack.knowledge?.regionalRules).toMatchObject({ 'mod-drg-cn': { version: 'CHS-DRG 3.0', baseRateMinor: 500000, groups: [{ group: 'FM39', weightBp: 24000 }, { group: 'FM59', weightBp: 8000 }] } });
});

it.each<[string, (pack: HospitalDataPack) => void]>([
  ['service system', pack => { pack.cases[0]!.caseTruth.results[0]!.service.codeSystem = 'urn:unknown'; }],
  ['leaf in wrong panel', pack => { pack.cases[1]!.caseTruth.results[1]!.observations[0]!.analyte.code = '4548-4'; }],
  ['role capability', pack => { pack.organization.practitionerRoles[0]!.capabilities.push('unknown'); }],
  ['practitioner role', pack => { pack.organization.practitioners[0]!.roleId = 'missing'; }],
  ['missing order set member', pack => { pack.knowledge!.orderSetTemplates[0]!.members[0]!.code = 'absent'; }],
  ['known medication', pack => { pack.cases[0]!.priorHistory.medications = [{ codeSystem: 'urn:unknown', code: 'test' }]; }],
  ['allergy group', pack => { pack.cases[0]!.priorHistory.allergies = { status: 'confirmed', items: [{ groupCode: 'unknown', severity: 'mild', reaction: { en: 'rash', zh: '皮疹' } }] }; }],
  ['default route', pack => { pack.catalog.medications[0]!.routeCodes.default = 'absent'; }],
])('rejects a dangling %s reference', (_name, change) => {
  const pack = general(); change(pack);
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_REFERENCE' }));
});

it.each(['病历上写着肺炎', 'My code is ｊ１８．９', 'They called it cAp.', 'I had PNEUMONIA.'])('checks every Persona field for an unknown hidden diagnosis (%s)', phrase => {
  const pack = general();
  pack.cases[0]!.patientPersona.boundaries[0]!.zh = phrase;
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'PERSONA_TRUTH_LEAK' }));
});

it('exempts a qualified Prior History diagnosis and matches codes and aliases as whole terms', () => {
  const pack = general();
  const patient = pack.cases[0]!;
  patient.patientPersona.openingStatement.en = 'I am capable. J18.90 is written here.';
  expect(() => parseHospitalDataPack(pack)).not.toThrow();
  patient.priorHistory.diagnoses.push(patient.caseTruth.primaryDiagnosis);
  patient.patientPersona.medicationMemory.zh = '我知道以前患过肺炎。';
  expect(() => parseHospitalDataPack(pack)).not.toThrow();
});

it('distinguishes a hidden code from a known dotted descendant in the same coding system', () => {
  const pack = general();
  const patient = pack.cases[0]!;
  const hidden = { codeSystem: 'urn:example:diagnoses', code: 'D4' };
  const known = { ...hidden, code: 'D4.1' };
  pack.catalog.diagnoses.push({ ...hidden, display: { en: 'Hidden teaching diagnosis', zh: '隐藏演示诊断' } }, { ...known, display: { en: 'Known teaching diagnosis', zh: '既往演示诊断' } });
  patient.caseTruth.primaryDiagnosis = hidden;
  patient.priorHistory.diagnoses = [known];
  patient.patientPersona.openingStatement.en = 'My prior record says D4.1.';
  expect(() => parseHospitalDataPack(pack)).not.toThrow();
  patient.patientPersona.openingStatement.en = 'My prior record says D4.1. The new code is D4.';
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'PERSONA_TRUTH_LEAK' }));
  patient.patientPersona.openingStatement.en = 'I remember D4.1 and the hidden teaching diagnosis.';
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'PERSONA_TRUTH_LEAK' }));
});

it('validates a preoperative long-term order policy separately from its prerequisite investigations', () => {
  const pack = structuredClone(BUILTIN_DATA_PACKS['cn-cardiology']);
  const [intervention, investigation] = pack.catalog.procedures;
  expect(intervention?.defaultPreopOrderPolicy).toBe('stop-on-completion');
  expect(investigation?.defaultPreopOrderPolicy).toBe('continue-active');
  expect(intervention?.preopServices.map(service => service.code)).toEqual(['cag', 'renal']);
  Object.assign(intervention!, { defaultPreopOrderPolicy: 'unrecognized' });
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_PACK' }));
  Object.assign(intervention!, { defaultPreopOrderPolicy: 'continue-active' });
  intervention!.preopServices[0]!.code = 'absent';
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_REFERENCE' }));
});

it('provides an initial result for every pre-catheterization investigation and a staged result for every planned procedure prerequisite', () => {
  const sameCode = (first: { codeSystem: string; code: string }, second: typeof first) => first.codeSystem === second.codeSystem && first.code === second.code;
  for (const pack of Object.values(BUILTIN_DATA_PACKS)) {
    const template = pack.knowledge?.orderSetTemplates.find(item => item.id === 'pre-cath-kidney-check');
    for (const patient of pack.cases) {
      const results = patient.caseTruth.results;
      for (const service of template?.members ?? []) expect(results.some(item => item.stage === 'initial' && sameCode(item.service, service))).toBe(true);
      for (const coding of patient.caseTruth.expectedProcedures ?? []) {
        const procedure = findCatalogItem(pack, 'procedures', coding)!;
        for (const service of procedure.preopServices) expect(results.some(item => ['initial', 'inpatient'].includes(item.stage) && sameCode(item.service, service))).toBe(true);
      }
    }
  }
});

it('validates the service, analyte, unit and timestamp of a prior observation', () => {
  const pack = structuredClone(BUILTIN_DATA_PACKS['cn-cardiology']);
  const sample = pack.cases[0]!.priorHistory.observations[0]!;
  expect(sample).toMatchObject({ observedAt: '2026-01-15T01:00:00Z', value: 172, unit: 'µmol/L' });
  sample.unit = 'mg/dL';
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_REFERENCE' }));
  sample.unit = 'µmol/L'; sample.service.code = 'ecg';
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_REFERENCE' }));
  sample.service.code = 'renal'; sample.observedAt = 'yesterday';
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_PACK' }));
});

it('parses JSON and YAML in memory and freezes nested Patient Persona data', () => {
  const pack = general();
  expect(parseHospitalDataPack(JSON.stringify(pack))).toEqual(parseHospitalDataPack(stringify(pack, { aliasDuplicateObjects: false })));
  const compiled = parseHospitalDataPack(pack);
  expect(Object.isFrozen(compiled.cases[0]!.patientPersona.symptoms[0])).toBe(true);
});

it.each([-1, 1.5, 10])('rejects invalid currency precision %s', exponent => {
  const pack = general(); pack.manifest.currency.minorUnitExponent = exponent;
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_PACK' }));
});

it('supports an integer zero-decimal currency and rejects extra nested fields', () => {
  const pack = general(); pack.manifest.currency = { code: 'JPY', symbol: '¥', minorUnitExponent: 0 };
  expect(parseHospitalDataPack(pack).manifest.currency.minorUnitExponent).toBe(0);
  Object.assign(pack.cases[0]!.demographics, { answer: true });
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_PACK' }));
});

it('rejects a procedure in an undeclared location and a missing report predecessor', () => {
  const missingLocation = structuredClone(BUILTIN_DATA_PACKS['cn-cardiology']);
  missingLocation.catalog.procedures[0]!.defaultLocation = 'absent';
  expect(() => parseHospitalDataPack(missingLocation)).toThrowError(expect.objectContaining({ code: 'INVALID_REFERENCE' }));
  const pack = general();
  pack.cases[1]!.caseTruth.results[2]!.revision = 3;
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'INVALID_PACK' }));
});

it('rejects duplicate qualified codes and permits the same code in another system', () => {
  const pack = general();
  const diagnosis = structuredClone(pack.catalog.diagnoses[0]!);
  pack.catalog.diagnoses.push(diagnosis);
  expect(() => parseHospitalDataPack(pack)).toThrowError(expect.objectContaining({ code: 'DUPLICATE_KEY' }));
  diagnosis.codeSystem = 'urn:another:system';
  expect(findCatalogItem(parseHospitalDataPack(pack), 'diagnoses', diagnosis)).toEqual(diagnosis);
});

it('loads four bilingual outpatient teaching cases with a six-section SOAP+ template', () => {
  const pack = parseHospitalDataPack(BUILTIN_DATA_PACKS['global-general']);
  expect(pack.manifest.clinicalRecordTemplate.map(field => field.id)).toEqual(['concern', 'subjective', 'objective', 'assessment', 'plan', 'follow-up']);
  expect(pack.cases.map(item => [item.encounterClass, item.caseTruth.primaryDiagnosis.code])).toEqual([
    ['outpatient', 'J18.9'], ['outpatient', 'I21.4'], ['outpatient', 'E11.9'], ['outpatient', 'J06.9'],
  ]);
  expect(pack.cases[0]?.priorHistory.allergies).toMatchObject({ status: 'confirmed', items: [{ groupCode: 'penicillin', severity: 'severe' }] });
  expect(pack.cases[1]?.caseTruth.results).toContainEqual(expect.objectContaining({ stage: 'initial', revision: 2, amendmentReason: expect.anything() }));
  expect(pack.cases[2]?.caseTruth).toMatchObject({ secondaryDiagnoses: [{ code: 'N39.0' }], expectedMedications: [{ code: 'metformin' }, { code: 'nitrofurantoin' }] });
  expect(pack.cases[3]?.caseTruth.noMedication).toBe(true);
});
