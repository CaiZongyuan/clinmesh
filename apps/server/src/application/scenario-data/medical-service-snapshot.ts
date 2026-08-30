import {
  referenceMedicalServiceSchema,
  referenceValueSetEntrySchema,
} from '@clinmesh/contracts/reference-data'

export const syntheticNhcMedicalServiceSnapshot = referenceMedicalServiceSchema.array().parse([
  ['CBC', '合成血常规服务', 'LABORATORY', 'ITEM'],
  ['WBC', '合成白细胞计数服务', 'LABORATORY', 'ITEM'],
  ['HGB', '合成血红蛋白服务', 'LABORATORY', 'ITEM'],
  ['RBC', '合成红细胞计数服务', 'LABORATORY', 'ITEM'],
  ['MCV', '合成平均红细胞体积服务', 'LABORATORY', 'ITEM'],
  ['HCT', '合成红细胞压积服务', 'LABORATORY', 'ITEM'],
  ['HBA1C', '合成糖化血红蛋白服务', 'LABORATORY', 'ITEM'],
  ['FUNDUS', '合成眼底检查服务', 'IMAGING', 'ITEM'],
  ['DIABETES-EDUCATION', '合成糖尿病健康教育', 'TREATMENT', 'SESSION'],
].map(([code, display, categoryCode, billingUnitCode], index) => ({
  billingUnitCode,
  categoryCode,
  code: `CM-NHC-SERVICE-${code}`,
  display,
  id: `nhc-medical-service:nhc-medical-services-2026-08-28:CM-NHC-SERVICE-${code}`,
  sourceLocator: `nhc-medical-services.csv:${index + 2}`,
  status: 'active',
  system: 'urn:clinmesh:reference:nhc-medical-service',
  version: 'nhc-medical-services-2026-08-28',
})))

export const syntheticWstValueSetSnapshot = referenceValueSetEntrySchema.array().parse([
  ['service-category', 'LABORATORY', '检验服务'],
  ['service-category', 'EXAMINATION', '检查服务'],
  ['service-category', 'IMAGING', '影像服务'],
  ['service-category', 'TREATMENT', '治疗服务'],
  ['billing-unit', 'ITEM', '项目'],
  ['billing-unit', 'SESSION', '次'],
].map(([kind, code, display], index) => {
  const system = `urn:clinmesh:wst:${kind}`
  const valueSet = `urn:clinmesh:wst:ValueSet:${kind}`
  return {
    code,
    display,
    id: `wst-value-set:WS-T-CM-2026:${valueSet}:${code}`,
    sourceLocator: `wst-value-set.csv:${index + 2}`,
    status: 'active',
    system,
    valueSet,
    version: 'WS-T-CM-2026',
  }
}))
