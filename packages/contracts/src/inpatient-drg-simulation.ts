import { z } from 'zod'
import { drgGroupingResultSchema } from './drg'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const stamp = z.iso.datetime({ offset: true })
const text = z.string().min(1).max(1_000)

/**
 * DRG 处方推演输入（草稿）：只参与计价与对照，不落库、不改变临床事实或病组。
 * 数量口径与收费触发一致：药品按单次计量计价（发药口径），服务按次计价（执行口径）。
 */
export const inpatientDrgSimulationInputSchema = z.object({
  medications: z.array(z.object({ catalogItemId: id, catalogVersion: z.number().int().positive(),
    doseText: z.string().trim().min(1).max(120), frequencyCode: z.enum(['QD', 'BID', 'PRN']),
    doseQuantity: z.number().int().positive().max(100) }).strict()).max(20).default([]),
  services: z.array(z.object({ serviceId: id, serviceVersion: z.number().int().positive(),
    quantity: z.number().int().positive().max(100) }).strict()).max(20).default([]),
}).strict()

export type InpatientDrgSimulationInput = z.infer<typeof inpatientDrgSimulationInputSchema>

/** 推演条目：正式收费带净额，未记费承诺/预留/草稿为目录推算；estimatedFen=null 表示缺价，不以零值填充。 */
export const inpatientDrgSimulationItemSchema = z.object({
  kind: z.enum(['medication', 'service', 'surgery', 'material']),
  id,
  display: z.string().min(1).max(500),
  quantity: z.number().int().positive(),
  estimatedFen: z.number().int().safe().nullable(),
}).strict()

/** 草稿输入中未能在目录按 id+版本定位的条目，显式列出不完整原因。 */
export const inpatientDrgSimulationMissingSchema = z.object({
  kind: z.enum(['medication', 'service']),
  id,
}).strict()

/**
 * DRG 处方推演结果：正式收费、未记费承诺、治疗预留与草稿四类分别归集；
 * fingerprint 绑定病例与全部依赖版本，依赖变化即过期，迟到响应凭 fingerprint 隔离。
 */
export const inpatientDrgSimulationSchema = z.object({
  admissionId: id,
  evaluatedAt: stamp,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  rulesId: text,
  rulesVersion: text,
  /** 正式收费净额（含冲正），来自共享账务费用 owner。 */
  formal: z.object({ chargesFen: z.number().int().safe(), items: z.array(inpatientDrgSimulationItemSchema).max(500) }).strict(),
  /** 未记费承诺：已签署尚待发药/执行的医嘱与已申请未实施的手术，按当前目录价推算。 */
  committed: z.object({ items: z.array(inpatientDrgSimulationItemSchema).max(500) }).strict(),
  /** 后续治疗预留：预留本身不计费，转正式须通过业务引用替换，替换后不再出现在本组。 */
  reserved: z.object({ items: z.array(inpatientDrgSimulationItemSchema).max(500) }).strict(),
  /** 当前草稿推演：请求输入的假想条目计价，未命中目录的条目进 missing。 */
  draft: z.object({ items: z.array(inpatientDrgSimulationItemSchema).max(40), missing: z.array(inpatientDrgSimulationMissingSchema).max(40) }).strict(),
  /** 已覆盖成本：仅表达已发生收费占推演总额比例，缺成本与支付参数时不作盈亏结论。 */
  coverage: z.object({ coveredFen: z.number().int().safe(), estimatedTotalFen: z.number().int().safe(),
    coveredRatioBp: z.number().int().min(0).max(10_000).nullable(), note: z.string().max(500) }).strict(),
  /** formal=正式事实分组；projected=「若计划手术实施」的推演分组，不构成临床事实或正式病组。 */
  grouping: z.object({ formal: drgGroupingResultSchema, projected: drgGroupingResultSchema.nullable(), note: text }).strict(),
  incompleteness: z.object({ costMissing: z.boolean(), paymentReferenceMissing: z.boolean() }).strict(),
}).strict()

export type InpatientDrgSimulation = z.infer<typeof inpatientDrgSimulationSchema>

export const inpatientMaterialReservationSchema = z.object({
  id, admissionId: id,
  requestId: id.optional(),
  materialId: id,
  materialDisplay: z.string().min(1),
  quantity: z.number().int().positive(),
  /** 创建时按目录冻结的单价与推算金额；目录后续调价不回写。 */
  priceFen: z.number().int().nonnegative(),
  status: z.enum(['reserved', 'replaced', 'released']),
  reason: z.string().min(1),
  createdAt: stamp,
  replacedByMaterialUseId: id.optional(),
}).strict()

export const inpatientMaterialReservationListSchema = z.object({
  admissionId: id,
  encounterVersion: z.string().regex(/^\d+$/),
  reservations: z.array(inpatientMaterialReservationSchema),
}).strict()

export type InpatientMaterialReservation = z.infer<typeof inpatientMaterialReservationSchema>
export type InpatientMaterialReservationList = z.infer<typeof inpatientMaterialReservationListSchema>

export const inpatientMaterialReservationCreateInputSchema = z.object({
  admissionId: id,
  encounterVersion: z.string().regex(/^\d+$/),
  materialId: id,
  catalogVersion: z.number().int().positive(),
  quantity: z.number().int().positive().max(1_000),
  requestId: id.optional(),
  reason: z.string().trim().min(1).max(2000),
}).strict()

export const inpatientMaterialReservationReleaseInputSchema = z.object({
  admissionId: id,
  reservationId: id,
  reason: z.string().trim().min(1).max(2000),
}).strict()
