import {
  catalogInsuranceCoverageSchema,
  insuranceCoverageSchema,
  type CatalogInsuranceCoverage,
  type InsuranceCoverage,
} from '@clinmesh/contracts/insurance'
import { z } from 'zod'

export const frozenCatalogCoverageSchema = z.union([
  insuranceCoverageSchema,
  z.object({ unmapped: z.literal(true) }).strict(),
])

export type FrozenCatalogCoverage = z.infer<typeof frozenCatalogCoverageSchema>

export const UNMAPPED_COVERAGE_JSON = JSON.stringify({ unmapped: true })

export const CLASS_A_COVERAGE: CatalogInsuranceCoverage = { included: true, priorSelfPayBps: 0 }
export const CLASS_B_10_COVERAGE: CatalogInsuranceCoverage = { included: true, priorSelfPayBps: 1000 }
export const CLASS_B_15_COVERAGE: CatalogInsuranceCoverage = { included: true, priorSelfPayBps: 1500 }
export const CLASS_B_20_COVERAGE: CatalogInsuranceCoverage = { included: true, priorSelfPayBps: 2000 }
export const CLASS_C_COVERAGE: CatalogInsuranceCoverage = { included: false, priorSelfPayBps: 0 }

const specialtyLaboratoryCodes = new Set([
  'CN-LAB-CARDIAC',
  '2100404A',
  '2100404B',
  '2100504A',
  '2100604A',
  '2100704A',
  'CN-LAB-HBA1C',
  '1100301A',
  '1101204A',
  '0501703A',
])

export function defaultSyntheticLaboratoryCoverage(code: string): CatalogInsuranceCoverage {
  return specialtyLaboratoryCodes.has(code) ? CLASS_B_10_COVERAGE : CLASS_A_COVERAGE
}

export function parseCatalogInsuranceCoverage(raw: unknown): CatalogInsuranceCoverage | undefined {
  const parsed = catalogInsuranceCoverageSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

export function readConfigInsuranceCoverage(
  configJson: string | null | undefined,
  nestedKey?: 'examinationService' | 'imagingService' | 'pathologyService' | 'laboratoryService' | 'inpatientInvestigationBilling',
): CatalogInsuranceCoverage | undefined {
  if (configJson === null || configJson === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(configJson)
  } catch {
    return undefined
  }
  const record = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!record.success) return undefined
  if (nestedKey !== undefined) {
    const nested = z.record(z.string(), z.unknown()).safeParse(record.data[nestedKey])
    if (nested.success) {
      const parsedNested = parseCatalogInsuranceCoverage(nested.data.insuranceCoverage)
      if (parsedNested !== undefined) return parsedNested
    }
  }
  return parseCatalogInsuranceCoverage(record.data.insuranceCoverage)
}

export function buildFrozenCatalogCoverage(
  code: string,
  version: string,
  coverage: CatalogInsuranceCoverage | undefined,
): FrozenCatalogCoverage {
  if (coverage === undefined) return { unmapped: true }
  return {
    code,
    version,
    included: coverage.included,
    priorSelfPayBps: coverage.priorSelfPayBps,
  }
}

export function freezeCatalogCoverageJson(
  code: string,
  version: string,
  coverage: CatalogInsuranceCoverage | undefined,
): string {
  if (coverage === undefined) return UNMAPPED_COVERAGE_JSON
  return JSON.stringify(buildFrozenCatalogCoverage(code, version, coverage))
}

export function parseFrozenCoverageJson(
  rawJson: string | null,
): { status: 'absent' } | { status: 'invalid' } | { status: 'valid'; coverage: InsuranceCoverage } {
  if (rawJson === null) return { status: 'absent' }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawJson)
  } catch {
    return { status: 'invalid' }
  }
  const parsed = insuranceCoverageSchema.safeParse(parsedJson)
  return parsed.success ? { status: 'valid', coverage: parsed.data } : { status: 'invalid' }
}
