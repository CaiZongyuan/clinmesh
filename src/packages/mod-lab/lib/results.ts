import type { z } from 'zod';
import type { Coding, HospitalDataPack } from '../../data-pack';
import type { findings } from './contracts';

type Truth = HospitalDataPack['cases'][number]['caseTruth'];
type Service = HospitalDataPack['catalog']['services'][number];
type Result = Truth['results'][number];
type Observation = Result['observations'][number];
type Leaf = Service['analytes'][number];
const sameCoding = (first: Coding, second: Coding) => first.code === second.code && first.codeSystem === second.codeSystem;
const nanogramsPerLiter: Record<string, number> = { 'g/L': 1e9, 'g/dL': 1e10, 'mg/L': 1e6, 'mg/dL': 1e7, 'µg/mL': 1e6, 'µg/L': 1e3, 'ng/mL': 1e3, 'ng/L': 1, 'pg/mL': 1 };
const nanomolesPerLiter: Record<string, number> = { 'mol/L': 1e9, 'mmol/L': 1e6, 'µmol/L': 1e3, 'nmol/L': 1 };
const countPerLiter: Record<string, number> = { '10*3/uL': 1e9, '10*9/L': 1e9, '10*6/uL': 1e12, '10*12/L': 1e12 };
const normalizeUnit = (unit: string) => unit.replace(/^[uμ](?=[gm])/, 'µ');

function measuredValue(leaf: Leaf, observation: Observation) {
  const to = normalizeUnit(leaf.unit);
  if (to === 'qualitative') return typeof observation.value === 'string' && (!observation.unit || observation.unit === to) ? observation.value : undefined;
  if (typeof observation.value !== 'number' || (!observation.unit && to !== '1')) return undefined;
  const from = normalizeUnit(observation.unit ?? '1');
  if (from === to) return observation.value;
  let factor: number | undefined;
  for (const units of [nanogramsPerLiter, nanomolesPerLiter, countPerLiter]) {
    if (Object.hasOwn(units, from) && Object.hasOwn(units, to)) factor = units[from]! / units[to]!;
  }
  if (leaf.codeSystem === 'http://loinc.org' && leaf.code === '2339-0' && from === 'mg/dL' && to === 'mmol/L') factor = 0.0555075;
  if (leaf.codeSystem === 'http://loinc.org' && ['14682-9', '2160-0'].includes(leaf.code)) {
    if (from === 'mg/dL' && to === 'µmol/L') factor = 88.4;
    if (from === 'µmol/L' && to === 'mg/dL') factor = 1 / 88.4;
  }
  if (factor === undefined) return undefined;
  const value = observation.value * factor;
  return Number.isFinite(value) ? value : undefined;
}

function interpret(leaf: Leaf, observation: Observation) {
  const value = measuredValue(leaf, observation);
  if (value === undefined) return undefined;
  let interpretation = observation.interpretation;
  let critical = false;
  if (typeof value === 'number') {
    const low = leaf.critical?.low !== undefined && value <= leaf.critical.low;
    const high = leaf.critical?.high !== undefined && value >= leaf.critical.high;
    critical = low || high;
    if (low || (leaf.referenceRange?.low !== undefined && value < leaf.referenceRange.low)) interpretation = 'low';
    else if (high || (leaf.referenceRange?.high !== undefined && value > leaf.referenceRange.high)) interpretation = 'high';
    else if (leaf.referenceRange && !interpretation) interpretation = 'normal';
  }
  if (!interpretation) return undefined;
  return { codeSystem: leaf.codeSystem, code: leaf.code, display: leaf.display, unit: leaf.unit, value, interpretation, critical };
}

function project(service: Service, source: Pick<Result, 'summary' | 'observations' | 'amendmentReason'>): z.infer<typeof findings> | undefined {
  const observations = [];
  for (const leaf of service.analytes) {
    const item = source.observations.find(item => sameCoding(item.analyte, leaf));
    const observation = item && interpret(leaf, item);
    if (!observation) return undefined;
    observations.push(observation);
  }
  return { summary: source.summary, observations, ...(source.amendmentReason && { amendmentReason: source.amendmentReason }) };
}

export function resolveFindings(truth: Pick<Truth, 'results' | 'normalBaselines'>, service: Service, stages: Result['stage'][], revision: number) {
  const matches = truth.results.filter(result => sameCoding(result.service, service));
  const stage = stages.find(stage => matches.some(result => result.stage === stage));
  if (stage) {
    const result = matches.find(result => result.stage === stage && result.revision === revision);
    return result && project(service, result);
  }
  const baseline = truth.normalBaselines?.find(item => sameCoding(item.service, service));
  if (!baseline || revision !== 1) return undefined;
  if (matches.some(result => !service.analytes.length || !project(service, result))) return undefined;
  const conflicts = truth.results.some(result => result.observations.some(observation => {
    const leaf = service.analytes.find(item => sameCoding(item, observation.analyte));
    return leaf && interpret(leaf, observation)?.interpretation !== 'normal';
  }));
  if (conflicts) return undefined;
  const normal = project(service, baseline);
  return normal?.observations.every(item => !item.critical && item.interpretation === 'normal') ? normal : undefined;
}
