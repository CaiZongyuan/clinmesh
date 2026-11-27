import { z } from 'zod';
import { knowledgeSchema, type HospitalDataPack } from '../../data-pack';
import { completedWardProcedures } from '../../mod-inpatient';
import { localizedName, type ReadContext } from '../../platform';
import { catalogCoding, sameCoding, type ClinicalFacts } from './facts';
import { activeDrugs, drugContraindication, drugDefinitions, incompatible, recentCreatinine, renalRisk } from './quality';

const evidence = z.object({ codeSystem: z.string(), code: z.string(), unit: z.string(), value: z.union([z.number(), z.string(), z.boolean()]), observedAt: z.iso.datetime(), source: z.object({ reference: z.string(), versionId: z.string(), label: z.string() }) });
const evidenceView = { observations: z.array(evidence), missingInputs: z.array(z.string()) };
export const guidelinesSchema = z.object({ population: z.enum(['adult', 'pediatric', 'all-only']), topics: z.array(knowledgeSchema.shape.guidelineTopics.element.extend(evidenceView)), ...evidenceView });
export function guidelines(data: ClinicalFacts) {
  const population = typeof data.age !== 'number' || data.age < 0 ? 'all-only' : data.age < 18 ? 'pediatric' : 'adult';
  const topics = data.knowledge.guidelineTopics.filter(topic => topic.population === 'all' || topic.population === population).map(topic => {
    const observations = [], missingInputs = [];
    for (const coding of topic.evidence ?? data.historical?.topicEvidence[topic.id] ?? []) {
      const fact = data.observed.filter(item => sameCoding(coding, item)).sort((first, second) => Date.parse(second.observedAt) - Date.parse(first.observedAt))[0];
      if (fact) observations.push(fact);
      else missingInputs.push(`${coding.codeSystem}|${coding.code}`);
    }
    return { ...topic, observations, missingInputs };
  });
  return guidelinesSchema.parse({ population, topics, observations: [...new Set(topics.flatMap(topic => topic.observations))], missingInputs: [...new Set(topics.flatMap(topic => topic.missingInputs))] });
}

const state = z.enum(['unavailable', 'excluded', 'skipped', 'needs-review', 'ready']);
const member = z.object({ kind: z.string(), codeSystem: z.string(), code: z.string(), catalogId: z.uuidv7().nullable(), display: localizedName, status: state, reason: z.string() });
export const orderSetsSchema = z.array(z.object({ id: z.string(), version: z.string(), name: localizedName, members: z.array(member), executions: z.array(z.object({ id: z.uuidv7(), completedAt: z.iso.datetime() })).default([]) }));
type Template = NonNullable<HospitalDataPack['knowledge']>['orderSetTemplates'][number];
export function orderSets(context: ReadContext, data: ClinicalFacts) {
  const { reader, actor } = context;
  const active = activeDrugs(reader, actor.at, data);
  const drugs = drugDefinitions(data);
  const available = (id: string) => context.moduleEnabled?.(id) ?? actor.enabledModules.includes(id);
  const postoperative = data.encounter.encounter_class === 'inpatient' ? completedWardProcedures(reader, actor.at, data.encounter.id) : [];
  const compatible = (template: Template) => template.scope === data.encounter.encounter_class || (template.scope === 'postop' && postoperative.some(stage => stage.postoperativeSetId === template.id));
  return data.knowledge.orderSetTemplates.filter(compatible).filter(template => !template.triggerDiagnoses.length || template.triggerDiagnoses.some(code => data.diagnoses.some(diagnosis => sameCoding(code, diagnosis)))).map(template => ({
    id: template.id, version: data.pack.pack_version, name: template.name, executions: postoperative.filter(stage => stage.postoperativeSetId === template.id).map(stage => ({ id: stage.execution.id, completedAt: stage.execution.virtual_at })), members: template.members.map(entry => {
      const item = data.catalog.find(row => row.kind === entry.kind && sameCoding(catalogCoding(row), entry));
      const serviceKind = item?.definition.kind;
      const required = entry.kind === 'medications' ? (data.encounter.encounter_class === 'inpatient' ? 'mod-inpatient' : 'mod-pharmacy') : (entry.kind !== 'services' || serviceKind === 'nursing' || item?.definition.requiresProcedure) ? 'mod-inpatient' : serviceKind === 'imaging' ? 'mod-imaging' : serviceKind === 'pathology' ? 'mod-pathology' : 'mod-lab';
      const value = { ...entry, catalogId: item?.id ?? null, display: localizedName.parse(item?.definition.display ?? { en: entry.code, zh: entry.code }) };
      const result = (status: z.infer<typeof state>, reason: string) => ({ ...value, status, reason });
      if (!item || item.amount_minor === null || !available(required)) return result('unavailable', 'catalog-unavailable');
      if (template.hardContraindications.some(code => data.diagnoses.some(diagnosis => sameCoding(code, diagnosis)))) return result('excluded', 'diagnosis-contraindication');
      const drug = drugs.find(drug => drug.id === item.id);
      if (drug) {
        const contraindication = drugContraindication(data, drug);
        if (contraindication) return result('excluded', contraindication);
        const { minimumHeartRate, minimumSystolic } = drug.safety;
        if ((minimumHeartRate && data.facts.heartRateBpm && data.facts.heartRateBpm.value < minimumHeartRate) || (minimumSystolic && data.facts.systolicBpMmHg && data.facts.systolicBpMmHg.value < minimumSystolic)) return result('excluded', 'vital-sign-contraindication');
        if (active.some(other => incompatible(data, drug, other))) return result('skipped', 'already-active-medication');
        if ((minimumHeartRate && !data.facts.heartRateBpm) || (minimumSystolic && !data.facts.systolicBpMmHg) || (renalRisk(drug) && !recentCreatinine(data)) || data.caseView.priorHistory.allergies.status === 'not-asked') return result('needs-review', 'pending-verification');
      } else if (data.orders.some(order => order.catalog_item_id === item.id && ['issued', 'accepted', 'in-progress', 'signed', 'verified'].includes(order.status))) return result('skipped', 'in-flight-order');
      if (template.requiredEvidence.some(code => !data.reports.some(report => sameCoding(code, report.service)))) return result('needs-review', 'missing-required-evidence');
      return result('ready', 'available');
    }),
  }));
}
