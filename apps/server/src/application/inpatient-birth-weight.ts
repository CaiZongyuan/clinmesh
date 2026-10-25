import { z } from 'zod'
import type { FhirResource } from '@clinmesh/contracts/fhir'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'

const measurement = z.object({
  id: z.string(), meta: z.object({ versionId: z.string() }),
  status: z.enum(['final', 'amended', 'corrected']),
  valueQuantity: z.object({ value: z.number().positive(), system: z.literal('http://unitsofmeasure.org'), code: z.enum(['g', 'kg']) }),
})
const observationCode = z.object({ code: z.object({ coding: z.array(z.object({ system: z.string().optional(), code: z.string().optional() })).optional() }).optional() })

/** 出生体重读取既有 Observation；冲突或缺失保持未知，不以当前体重替代。 */
export function readInpatientBirthWeight(fhir: FhirRepository, context: RepositoryContext, patientId: string) {
  const resources: FhirResource[] = []
  const query = new URLSearchParams({ patient: `Patient/${patientId}`, _count: '100' })
  let cursor: string | undefined
  do {
    const page = fhir.search(context, 'Observation', query)
    for (const resource of page.resources) {
      const coding = observationCode.parse(resource)
      if (['final', 'amended', 'corrected'].includes(String(resource.status))
        && coding.code?.coding?.some(code => code.system === 'http://loinc.org' && code.code === '8339-4')) resources.push(resource)
    }
    cursor = page.nextCursor
    if (cursor !== undefined) query.set('_cursor', cursor)
  } while (cursor !== undefined)
  const observations = resources.map(resource => ({ id: resource.id!, version: resource.meta!.versionId! }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const grams = resources.map(resource => {
    const parsed = measurement.safeParse(resource)
    if (!parsed.success) return null
    const { value, code } = parsed.data.valueQuantity
    const scaled = code === 'kg' ? value * 1_000 : value
    const result = Math.round(scaled)
    return Math.abs(scaled - result) < 1e-7 && Number.isSafeInteger(result) && result > 0 && result <= 10_000 ? result : null
  })
  const distinct = new Set(grams)
  return { resources, snapshot: resources.length === 0 ? undefined : {
    grams: distinct.size === 1 ? grams[0]! : null, observations,
  } }
}
