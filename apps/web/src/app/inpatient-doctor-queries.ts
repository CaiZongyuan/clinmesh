import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { apiGet, apiMutation } from './api-client.ts'

/** DRG 预分组：只读推算；归档病例返回归档时冻结的分组。 */
export function fetchInpatientDrgPregroup(admissionId: string, signal?: AbortSignal) {
  return apiGet(`/api/his/v1/inpatient/admissions/${admissionId}/drg/pregroup`, inpatientDrgPregroupResultSchema, signal)
}

/** DRG 处方推演：只读对照（正式收费、承诺、预留与推演分组），不落库、不收费，无需幂等键。 */
export function runInpatientDrgSimulation(admissionId: string, signal?: AbortSignal) {
  return apiMutation(`/api/his/v1/inpatient/admissions/${admissionId}/drg/simulation`, inpatientDrgSimulationSchema, {},
    signal === undefined ? {} : { signal })
}
