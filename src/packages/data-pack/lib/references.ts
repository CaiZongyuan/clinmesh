import { medicationRouteSchema } from '../../store';
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
  return value.normalize('NFKC').toLowerCase().replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ');
}

function termPattern(term: string) {
  const needle = normalized(term);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^[a-z0-9]/.test(needle) ? '(?<![a-z0-9])' : '';
  const right = /[a-z0-9]$/.test(needle) ? '(?![a-z0-9])' : '';
  return new RegExp(`${left}${escaped}${right}`, 'u');
}

function groupBy<Item>(items: Iterable<Item>, key: (item: Item) => string) {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const id = key(item);
    const members = groups.get(id);
    if (members) members.push(item);
    else groups.set(id, [item]);
  }
  return groups;
}

function registeredCodes(diagnoses: Diagnosis[]) {
  const systems = groupBy(diagnoses, item => item.codeSystem);
  return new Map(Array.from(systems, ([system, entries]) => {
    const longestFirst = entries.map(item => normalized(item.code)).sort((first, second) => second.length - first.length);
    return [system, groupBy(longestFirst, code => code.charAt(0))] as const;
  }));
}

function withinWord(left: string | undefined, right: string | undefined) {
  return left !== undefined && right !== undefined && /[a-z0-9]/u.test(left) && /[a-z0-9]/u.test(right);
}

function mentionsCode(text: string, byInitial: ReadonlyMap<string, string[]>, hidden: ReadonlySet<string>) {
  for (let start = 0; start < text.length;) {
    const initial = text[start]!;
    const match = withinWord(text[start - 1], initial) ? undefined : byInitial.get(initial)?.find(code =>
      text.startsWith(code, start) && !withinWord(code.at(-1), text[start + code.length]),
    );
    if (match && hidden.has(match)) return true;
    start += match?.length ?? 1;
  }
  return false;
}

export function diagnosisDisclosureGuard(catalog: Diagnosis[]) {
  const codes = registeredCodes(catalog);
  const diagnoses = indexBy(catalog, codingKey, 'catalog.diagnoses');
  return (prior: Coding[], answers: Coding[]) => {
    const known = new Set(prior.map(codingKey));
    const hidden = answers.filter(item => !known.has(codingKey(item))).map(item => reference(diagnoses, codingKey(item), 'caseTruth.diagnoses'));
    const groups = Array.from(groupBy(hidden, item => item.codeSystem), ([system, entries]) => {
      const hiddenCodes = new Set(entries.map(entry => normalized(entry.code)));
      const names = entries.flatMap(entry => [entry.display.en, entry.display.zh, ...entry.aliases ?? []])
        .filter(name => !hiddenCodes.has(normalized(name))).map(termPattern);
      return { registered: codes.get(system)!, hiddenCodes, names };
    });
    return (speech: string) => {
      const field = normalized(speech);
      return !groups.some(({ registered, hiddenCodes, names }) => mentionsCode(field, registered, hiddenCodes) || names.some(pattern => pattern.test(field)));
    };
  };
}

function checkPersona(patient: ClinicalCase, guard: ReturnType<typeof diagnosisDisclosureGuard>) {
  const accepts = guard(patient.priorHistory.diagnoses, [patient.caseTruth.primaryDiagnosis, ...patient.caseTruth.secondaryDiagnoses]);
  const persona = patient.patientPersona;
  const speech = [persona.character, persona.healthLiteracy, persona.speechStyle, persona.openingStatement, ...persona.symptoms, persona.medicationMemory, ...persona.boundaries];
  if (speech.some(field => !accepts(field.en) || !accepts(field.zh))) throw new DataPackError('PERSONA_TRUTH_LEAK', 'patientPersona');
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
    if (result.sections && result.sections.kind !== service.kind) throw new DataPackError('INVALID_PACK', 'results.sections.kind');
    const leaves = indexBy(service.analytes, codingKey, 'service.analytes');
    for (const leaf of indexBy(result.observations, item => codingKey(item.analyte), 'observations').keys()) reference(leaves, leaf, 'observations.analyte');
    if ((result.revision > 1) !== Boolean(result.amendmentReason)) throw new DataPackError('INVALID_PACK', 'results.amendmentReason');
    const key = JSON.stringify([service.codeSystem, service.code, result.stage, result.priorSurgeryId]);
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
  if (pack.manifest.enabledModules.includes('mod-inpatient') && !pack.knowledge?.inpatient) throw new DataPackError('INVALID_PACK', 'knowledge.inpatient');
  const pharmacyEnabled = pack.manifest.enabledModules.includes('mod-pharmacy');
  if (pharmacyEnabled && !pack.knowledge?.pharmacy) {
    throw new DataPackError('INVALID_PACK', 'knowledge.pharmacy');
  }
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
  for (const [index, drug] of catalog.medications.entries()) {
    if (pharmacyEnabled && drug.routeCodes.allowed.some(route => !medicationRouteSchema.safeParse(route).success)) {
      throw new DataPackError('INVALID_PACK', `catalog.medications.${index}.routeCodes.allowed`);
    }
    reference(distinct(drug.routeCodes.allowed, 'allowedRoutes'), drug.routeCodes.default, 'routeCodes.default');
    reference(distinct(drug.dosageUnits, 'dosageUnits'), drug.inpatientDoseBasis.unit, 'inpatientDoseBasis.unit');
    for (const group of distinct(drug.safety.allergyGroupCodes, 'allergyGroupCodes').keys()) allergyGroups.add(group);
    if (drug.safety.maxDailyDose < drug.safety.maxSingleDose) throw new DataPackError('INVALID_PACK', 'maxDailyDose');
  }
  for (const service of catalog.services) indexBy(service.analytes, codingKey, 'services.analytes');
  for (const procedure of catalog.procedures) requireCodes('services', procedure.preopServices, 'preopServices');
  if (pack.knowledge) {
    for (const alias of pack.knowledge.pharmacy?.indicationAliases ?? []) {
      reference(entries.diagnoses, codingKey(alias.diagnosis), 'pharmacy.indicationAliases');
      if (alias.equivalent.codeSystem !== pack.knowledge.pharmacy?.indicationCodeSystem) throw new DataPackError('INVALID_REFERENCE', 'pharmacy.indicationAliases.equivalent');
    }
    const lotKeys = new Set<string>();
    for (const lot of pack.knowledge.pharmacy?.openingStock ?? []) {
      for (const code of lot.medicationCodes) {
        const drug = reference(entries.medications, codingKey({ codeSystem: lot.codeSystem, code }), 'pharmacy.openingStock');
        const key = JSON.stringify([lot.codeSystem, code, lot.lotNumber]);
        if (drug.source !== 'internal') throw new DataPackError('INVALID_REFERENCE', 'pharmacy.openingStock.source');
        if (lotKeys.has(key)) throw new DataPackError('DUPLICATE_KEY', 'pharmacy.openingStock.lotNumber');
        lotKeys.add(key);
      }
    }
    indexBy(pack.knowledge.guidelineTopics, item => item.id, 'guidelineTopics');
    indexBy(pack.knowledge.orderSetTemplates, item => item.id, 'orderSetTemplates');
    const inpatient = pack.knowledge.inpatient;
    if (inpatient) {
      const nursing = (code: Coding) => {
        if (reference(entries.services, codingKey(code), 'inpatient.nursing').kind !== 'nursing') throw new DataPackError('INVALID_REFERENCE', 'inpatient.nursing');
      };
      nursing(inpatient.bedDay);
      if (!Object.keys(inpatient.schedules).length || ['ONCE', 'PRN'].some(key => Object.hasOwn(inpatient.schedules, key))) throw new DataPackError('INVALID_PACK', 'inpatient.schedules');
      for (const lot of indexBy(inpatient.materialStock, lot => JSON.stringify([codingKey(lot.item), lot.lotNumber]), 'inpatient.materialStock').values()) reference(entries.materials, codingKey(lot.item), 'inpatient.materialStock');
      for (const procedure of indexBy(inpatient.procedures, proc => codingKey(proc.item), 'inpatient.procedures').values()) {
        reference(entries.procedures, codingKey(procedure.item), 'inpatient.procedures');
        if (procedure.nursing) nursing(procedure.nursing);
        const report = procedure.reportService && reference(entries.services, codingKey(procedure.reportService), 'inpatient.reportService');
        if (procedure.kind === 'angiography' && !report?.requiresProcedure || procedure.ffr && !report?.analytes.some(leaf => codingKey(leaf) === codingKey(procedure.ffr!) && leaf.unit === '1')) throw new DataPackError('INVALID_REFERENCE', 'inpatient.reportService');
        if (procedure.postoperativeSetId && !pack.knowledge.orderSetTemplates.some(set => set.id === procedure.postoperativeSetId && set.scope === 'postop')) throw new DataPackError('INVALID_REFERENCE', 'inpatient.postoperativeSetId');
      }
    }
    for (const template of pack.knowledge.orderSetTemplates) {
      requireCodes('diagnoses', template.triggerDiagnoses, 'triggerDiagnoses');
      requireCodes('diagnoses', template.hardContraindications, 'hardContraindications');
      requireCodes('services', template.requiredEvidence, 'requiredEvidence');
      indexBy(template.members, member => JSON.stringify([member.kind, codingKey(member)]), 'orderSetTemplates.members');
      for (const member of template.members) requireCodes(member.kind, [member], 'orderSetTemplates.members');
    }
  }
  indexBy(pack.cases, item => JSON.stringify([item.caseId, item.version]), 'cases');
  const guard = diagnosisDisclosureGuard(catalog.diagnoses);
  for (const patient of pack.cases) {
    indexBy(patient.demographics.identifiers, id => JSON.stringify([id.issuer, id.value]), 'demographics.identifiers');
    requireCodes('diagnoses', patient.priorHistory.diagnoses, 'priorHistory.diagnoses');
    requireCodes('medications', patient.priorHistory.medications, 'priorHistory.medications');
    for (const sample of patient.priorHistory.observations) {
      const service = reference(entries.services, codingKey(sample.service), 'priorHistory.observations.service');
      const analyte = service.analytes.find(item => codingKey(item) === codingKey(sample.analyte));
      if (!analyte || analyte.unit !== sample.unit) throw new DataPackError('INVALID_REFERENCE', 'priorHistory.observations.analyte');
    }
    const allergies = patient.priorHistory.allergies;
    if (allergies.status === 'confirmed' && allergies.items.some(item => !allergyGroups.has(item.groupCode))) throw new DataPackError('INVALID_REFERENCE', 'priorHistory.allergies');
    const truth = patient.caseTruth;
    const surgeries = indexBy(patient.priorHistory.surgeries ?? [], item => item.id, 'priorHistory.surgeries');
    for (const result of truth.results) {
      if (result.priorSurgeryId) reference(surgeries, result.priorSurgeryId, 'results.priorSurgeryId');
      if ((result.sections?.kind === 'pathology') !== Boolean(result.priorSurgeryId)) throw new DataPackError('INVALID_PACK', 'results.priorSurgeryId');
    }
    requireCodes('diagnoses', [truth.primaryDiagnosis, ...truth.secondaryDiagnoses], 'caseTruth.diagnoses');
    requireCodes('medications', truth.expectedMedications ?? [], 'expectedMedications');
    requireCodes('procedures', truth.expectedProcedures ?? [], 'expectedProcedures');
    requireCodes('materials', truth.expectedMaterials ?? [], 'expectedMaterials');
    if (truth.noMedication && truth.expectedMedications?.length) throw new DataPackError('INVALID_PACK', 'noMedication');
    checkResults(truth.results, entries.services);
    if (truth.normalBaselines) {
      requireCodes('services', truth.normalBaselines.map(baseline => baseline.service), 'caseTruth.normalBaselines');
      checkResults(truth.normalBaselines.map(baseline => ({ ...baseline, stage: 'initial', revision: 1 })), entries.services);
    }
    checkPersona(patient, guard);
  }
  return entries;
}
