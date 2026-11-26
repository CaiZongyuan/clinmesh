import { DataPackError } from './errors';
import type { CatalogKind, Coding, HospitalDataPack } from './schema';

type Catalog = HospitalDataPack['catalog'];
type ClinicalCase = HospitalDataPack['cases'][number];
type Diagnosis = Catalog['diagnoses'][number];
export const codingKey = ({ codeSystem, code }: Coding) => JSON.stringify([codeSystem, code]);

function indexBy<Item>(items: readonly Item[], key: (item: Item) => string, path: string) {
  const index = new Map<string, Item>();
  for (const item of items) {
    const id = key(item);
    if (index.has(id)) throw new DataPackError('DUPLICATE_KEY', path);
    index.set(id, item);
  }
  return index;
}

function distinct(items: string[], path: string) {
  return indexBy(items, item => item, path);
}

function reference<Item>(index: ReadonlyMap<string, Item>, id: string, path: string): Item {
  const item = index.get(id);
  if (item === undefined) throw new DataPackError('INVALID_REFERENCE', path);
  return item;
}

function normalized(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\u200b-\u200d\ufeff]/gu, '').replace(/\s+/gu, ' ');
}

function containsTerm(text: string, term: string) {
  const needle = normalized(term);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^[a-z0-9]/.test(needle) ? '(?<![a-z0-9])' : '';
  const right = /[a-z0-9]$/.test(needle) ? '(?![a-z0-9])' : '';
  return new RegExp(`${left}${escaped}${right}`, 'u').test(text);
}

function checkPersona(patient: ClinicalCase, diagnoses: ReadonlyMap<string, Diagnosis>) {
  const known = new Set(patient.priorHistory.diagnoses.map(codingKey));
  const persona = patient.patientPersona;
  const speech = [persona.character, persona.healthLiteracy, persona.speechStyle, persona.openingStatement, ...persona.symptoms, persona.medicationMemory, ...persona.boundaries]
    .flatMap(field => [normalized(field.en), normalized(field.zh)]);
  for (const diagnosis of [patient.caseTruth.primaryDiagnosis, ...patient.caseTruth.secondaryDiagnoses]) {
    const key = codingKey(diagnosis);
    const entry = reference(diagnoses, key, 'caseTruth.diagnoses');
    if (known.has(key)) continue;
    const terms = [entry.code, entry.display.en, entry.display.zh, ...entry.aliases ?? []];
    if (terms.some(term => speech.some(field => containsTerm(field, term)))) throw new DataPackError('PERSONA_TRUTH_LEAK', 'patientPersona');
  }
}

function checkOrganization({ manifest, organization, catalog }: HospitalDataPack) {
  reference(distinct(manifest.supportedLocales, 'supportedLocales'), manifest.defaultLocale, 'defaultLocale');
  distinct(manifest.enabledModules, 'enabledModules');
  distinct(manifest.policies.completionGates, 'completionGates');
  const ids = <Item extends { id: string }>(items: Item[], path: string) => indexBy(items, item => item.id, path);
  ids(manifest.policies.shiftSchedule, 'shiftSchedule');
  ids(manifest.clinicalRecordTemplate, 'clinicalRecordTemplate');
  const departments = ids(organization.departments, 'departments');
  for (const field of manifest.clinicalRecordTemplate) if (field.showWhen?.departmentId) reference(departments, field.showWhen.departmentId, 'showWhen.departmentId');
  const wards = ids(organization.wards, 'wards');
  ids(organization.beds, 'beds');
  for (const ward of wards.values()) reference(departments, ward.departmentId, 'wards.departmentId');
  for (const bed of organization.beds) reference(wards, bed.wardId, 'beds.wardId');
  for (const procedure of catalog.procedures) {
    if (!wards.has(procedure.defaultLocation) && !departments.has(procedure.defaultLocation)) throw new DataPackError('INVALID_REFERENCE', 'defaultLocation');
  }
  const capabilities = distinct(organization.capabilities, 'organization.capabilities');
  const roles = ids(organization.practitionerRoles, 'practitionerRoles');
  for (const role of roles.values()) {
    for (const capability of distinct(role.capabilities, 'role.capabilities').keys()) reference(capabilities, capability, 'role.capabilities');
  }
  ids(organization.practitioners, 'practitioners');
  for (const practitioner of organization.practitioners) {
    reference(departments, practitioner.departmentId, 'practitioners.departmentId');
    reference(roles, practitioner.roleId, 'practitioners.roleId');
  }
}

function checkResults(results: ClinicalCase['caseTruth']['results'], services: ReadonlyMap<string, Catalog['services'][number]>) {
  const revisions = new Map<string, number[]>();
  for (const result of results) {
    const service = reference(services, codingKey(result.service), 'results.service');
    const leaves = indexBy(service.analytes, codingKey, 'service.analytes');
    for (const leaf of indexBy(result.observations, item => codingKey(item.analyte), 'observations').keys()) reference(leaves, leaf, 'observations.analyte');
    if ((result.revision > 1) !== Boolean(result.amendmentReason)) throw new DataPackError('INVALID_PACK', 'results.amendmentReason');
    const key = JSON.stringify([service.codeSystem, service.code, result.stage]);
    const chain = revisions.get(key) ?? [];
    chain.push(result.revision);
    revisions.set(key, chain);
  }
  for (const chain of revisions.values()) {
    if (!chain.sort((first, second) => first - second).every((value, index) => value === index + 1)) throw new DataPackError('INVALID_PACK', 'results.revision');
  }
}

export const catalogKinds = ['diagnoses', 'medications', 'services', 'procedures', 'materials'] as const satisfies CatalogKind[];

export function validateReferences(pack: HospitalDataPack) {
  checkOrganization(pack);
  const catalog = pack.catalog;
  const entries = {
    diagnoses: indexBy(catalog.diagnoses, codingKey, 'catalog.diagnoses'), medications: indexBy(catalog.medications, codingKey, 'catalog.medications'),
    services: indexBy(catalog.services, codingKey, 'catalog.services'), procedures: indexBy(catalog.procedures, codingKey, 'catalog.procedures'),
    materials: indexBy(catalog.materials, codingKey, 'catalog.materials'),
  };
  const requireCodes = (kind: CatalogKind, codes: Coding[], path: string) => {
    const index: ReadonlyMap<string, Coding> = entries[kind];
    for (const key of indexBy(codes, codingKey, path).keys()) reference(index, key, path);
  };
  const allergyGroups = new Set<string>();
  for (const drug of catalog.medications) {
    reference(distinct(drug.routeCodes.allowed, 'allowedRoutes'), drug.routeCodes.default, 'routeCodes.default');
    reference(distinct(drug.dosageUnits, 'dosageUnits'), drug.inpatientDoseBasis.unit, 'inpatientDoseBasis.unit');
    for (const group of distinct(drug.safety.allergyGroupCodes, 'allergyGroupCodes').keys()) allergyGroups.add(group);
    if (drug.safety.maxDailyDose < drug.safety.maxSingleDose) throw new DataPackError('INVALID_PACK', 'maxDailyDose');
  }
  for (const service of catalog.services) indexBy(service.analytes, codingKey, 'services.analytes');
  for (const procedure of catalog.procedures) requireCodes('services', procedure.defaultPreopOrderPolicy, 'defaultPreopOrderPolicy');
  if (pack.knowledge) {
    indexBy(pack.knowledge.guidelineTopics, item => item.id, 'guidelineTopics');
    indexBy(pack.knowledge.orderSetTemplates, item => item.id, 'orderSetTemplates');
    for (const template of pack.knowledge.orderSetTemplates) {
      requireCodes('diagnoses', template.triggerDiagnoses, 'triggerDiagnoses');
      requireCodes('diagnoses', template.hardContraindications, 'hardContraindications');
      requireCodes('services', template.requiredEvidence, 'requiredEvidence');
      indexBy(template.members, member => JSON.stringify([member.kind, codingKey(member)]), 'orderSetTemplates.members');
      for (const member of template.members) requireCodes(member.kind, [member], 'orderSetTemplates.members');
    }
  }
  indexBy(pack.cases, item => JSON.stringify([item.caseId, item.version]), 'cases');
  for (const patient of pack.cases) {
    indexBy(patient.demographics.identifiers, id => JSON.stringify([id.issuer, id.value]), 'demographics.identifiers');
    requireCodes('diagnoses', patient.priorHistory.diagnoses, 'priorHistory.diagnoses');
    requireCodes('medications', patient.priorHistory.medications, 'priorHistory.medications');
    const allergies = patient.priorHistory.allergies;
    if (allergies.status === 'confirmed' && allergies.items.some(item => !allergyGroups.has(item.groupCode))) throw new DataPackError('INVALID_REFERENCE', 'priorHistory.allergies');
    const truth = patient.caseTruth;
    requireCodes('diagnoses', [truth.primaryDiagnosis, ...truth.secondaryDiagnoses], 'caseTruth.diagnoses');
    requireCodes('medications', truth.expectedMedications ?? [], 'expectedMedications');
    requireCodes('procedures', truth.expectedProcedures ?? [], 'expectedProcedures');
    requireCodes('materials', truth.expectedMaterials ?? [], 'expectedMaterials');
    if (truth.noMedication && truth.expectedMedications?.length) throw new DataPackError('INVALID_PACK', 'noMedication');
    checkResults(truth.results, entries.services);
    checkPersona(patient, entries.diagnoses);
  }
  return entries;
}
