import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientDrgPregroupResultSchema } from '@clinmesh/contracts/inpatient-drg'
import { inpatientDrgSimulationSchema } from '@clinmesh/contracts/inpatient-drg-simulation'
import { apiGet, apiMutation } from './api-client.ts'

/** 住院工作台共享 query 前缀：与 inpatient-workspace、inpatient-clinical 等的 key 一致，同 scope 发起即命中同一缓存。 */
export function inpatientScopeKey(session: SessionContext): unknown[] {
  return ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
}

/** DRG 预分组：只读推算；归档病例返回归档时冻结的分组。 */
export function fetchInpatientDrgPregroup(admissionId: string, signal?: AbortSignal) {
  return apiGet(`/api/his/v1/inpatient/admissions/${admissionId}/drg/pregroup`, inpatientDrgPregroupResultSchema, signal)
}

/** DRG 处方推演：只读对照（正式收费、承诺、预留与推演分组），不落库、不收费，无需幂等键。 */
export function runInpatientDrgSimulation(admissionId: string, signal?: AbortSignal) {
  return apiMutation(`/api/his/v1/inpatient/admissions/${admissionId}/drg/simulation`, inpatientDrgSimulationSchema, {},
    signal === undefined ? {} : { signal })
}

/** 以虚拟时钟计算住院第 N 天（入科当日为第 1 天）；缺虚拟时钟或入科时间时不可知。 */
export function inpatientCareDay(admission: Pick<InpatientAdmission, 'admittedAt'>, virtualTime: string | undefined): number | undefined {
  if (admission.admittedAt === undefined || virtualTime === undefined) return undefined
  return Math.max(1, Math.floor((Date.parse(virtualTime) - Date.parse(admission.admittedAt)) / 86_400_000) + 1)
}
