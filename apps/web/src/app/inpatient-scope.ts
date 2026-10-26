import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'

export const DAY_MS = 86_400_000

/** 住院工作台共享 query 前缀：与 inpatient-workspace、inpatient-clinical 等的 key 一致，同 scope 发起即命中同一缓存。 */
export function inpatientScopeKey(session: SessionContext): unknown[] {
  return ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
}

/** 以虚拟时钟计算住院第 N 天（入科当日为第 1 天）；缺虚拟时钟或入科时间时不可知。 */
export function inpatientCareDay(admission: Pick<InpatientAdmission, 'admittedAt'>, virtualTime: string | undefined): number | undefined {
  if (admission.admittedAt === undefined || virtualTime === undefined) return undefined
  return Math.max(1, Math.floor((Date.parse(virtualTime) - Date.parse(admission.admittedAt)) / DAY_MS) + 1)
}
