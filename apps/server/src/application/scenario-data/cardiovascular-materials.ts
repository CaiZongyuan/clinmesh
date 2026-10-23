import { z } from 'zod'
import { inpatientMaterialReferenceSchema, inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import snapshot from './cardiovascular-materials.json' with { type: 'json' }

const reference = inpatientMaterialReferenceSchema.shape
type Reference = z.infer<typeof inpatientMaterialReferenceSchema>
type Material = z.infer<typeof inpatientSurgeryCatalogSchema>['materials'][number]
// 固定列顺序属于持久格式 v1；字段改名或重排须保留此读取顺序。
const originalColumns = ['类别','产品或支付类别名称','企业（原表口径）','型号或规格','中选价格（元）','原表计价单位','价格类型',
  '来源地区','执行起日','原周期止日','适用性说明','原耗材代码','注册证号','来源编号','原表定位','提取备注','基准品拟供应价（元）'] as const
const sourceColumns = ['来源编号','官方发布','价格类型','适用范围','执行起日','原协议止日','记录粒度','当前适用性','通知地址','原始附件','原件 SHA-256','提取说明'] as const
const storedReference = z.object({
  storageFormat: z.literal('cardiovascular-columns-v1'), workbookSha256: reference.workbookSha256, verifiedOn: reference.verifiedOn,
  sheet: reference.sheet, row: reference.row, priceFen: reference.priceFen, baseSupplyPriceFen: reference.baseSupplyPriceFen,
  effectiveFrom: reference.effectiveFrom, effectiveThrough: reference.effectiveThrough,
  originalValues: z.array(z.string()).length(originalColumns.length), sourceValues: z.array(z.string()).length(sourceColumns.length),
}).strict()
const storedMaterialMarker = z.object({ reference: z.object({ storageFormat: z.literal('cardiovascular-columns-v1') }).passthrough() }).passthrough()
const storedMaterial = z.object({ reference: storedReference }).passthrough()

function fullReference(input: Pick<Reference, 'workbookSha256' | 'verifiedOn' | 'sheet' | 'row' | 'priceFen' | 'baseSupplyPriceFen' | 'effectiveFrom' | 'effectiveThrough' | 'original' | 'source'>): Reference {
  const raw = input.original
  return { ...input, category: raw['类别'], enterprise: raw['企业（原表口径）'], specification: raw['型号或规格'] || null,
    unit: raw['原表计价单位'] === '原表未列' || raw['原表计价单位'] === '' ? null : raw['原表计价单位'],
    priceType: raw['价格类型'], region: raw['来源地区'], applicability: raw['适用性说明'],
    materialCode: raw['原耗材代码'] || null, registrationNumber: raw['注册证号'] || null,
    sourceId: raw['来源编号'], sourceLocator: raw['原表定位'] }
}

export function storeMaterialSnapshot(item: Material) {
  if (!item.reference) return item
  const { workbookSha256, verifiedOn, sheet, row, priceFen, baseSupplyPriceFen, effectiveFrom, effectiveThrough, original, source } = item.reference
  return { ...item, reference: { storageFormat: 'cardiovascular-columns-v1', workbookSha256, verifiedOn, sheet, row, priceFen, baseSupplyPriceFen,
    effectiveFrom, effectiveThrough, originalValues: originalColumns.map(column => original[column]), sourceValues: sourceColumns.map(column => source[column]) } }
}

export function readMaterialSnapshot(value: unknown): unknown {
  if (!storedMaterialMarker.safeParse(value).success) return value
  const item = storedMaterial.parse(value)
  const { storageFormat: _format, originalValues, sourceValues, ...rest } = item.reference
  const original = reference.original.parse(Object.fromEntries(originalColumns.map((column, index) => [column, originalValues[index]])))
  const source = reference.source.parse(Object.fromEntries(sourceColumns.map((column, index) => [column, sourceValues[index]])))
  return { ...item, reference: fullReference({ ...rest, original, source }) }
}

const data = z.object({
  workbookSha256: z.literal('76147edf46552c906750bb2a8697596cd47acf3450c322168f92a5b8e2348cc3'), verifiedOn: z.iso.date(),
  sources: z.record(z.string(), reference.source), records: z.array(z.object({ row: reference.row, priceFen: reference.priceFen,
    baseSupplyPriceFen: reference.baseSupplyPriceFen, effectiveFrom: reference.effectiveFrom, effectiveThrough: reference.effectiveThrough,
    original: reference.original }).strict()).length(231),
}).strict().parse(snapshot)

export const cardiovascularMaterials = inpatientSurgeryCatalogSchema.shape.materials.parse(data.records.map(record => {
  const raw = record.original
  const metadata = fullReference({ workbookSha256: data.workbookSha256, verifiedOn: data.verifiedOn, sheet: '心血管价格明细', ...record,
    source: reference.source.parse(data.sources[raw['来源编号']]) })
  const unit = metadata.unit
  const id = `hospital-material-cv-${record.row}`
  return { id, version: 1, display: `${raw['产品或支付类别名称']} · ${raw['企业（原表口径）']} · ${raw['来源编号']}-${record.row}`,
    reference: metadata,
    ...(unit === null ? { unavailableReason: 'unit-unconfirmed' } : {
      chargeDefinition: { id: `hospital-charge-cv-${record.row}`, priceFen: record.priceFen, unit, synthetic: true, trigger: 'execution' },
    }),
  }
}))
