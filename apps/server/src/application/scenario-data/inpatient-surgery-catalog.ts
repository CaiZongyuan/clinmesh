import { inpatientSurgeryCatalogSchema } from '@clinmesh/contracts/inpatient-surgery'
import { cardiovascularMaterials } from './cardiovascular-materials.ts'

/** 固定八条来源摘录；院内收费ID与合成演示价独立于临床分类编码。 */
export const syntheticInpatientSurgeryCatalog = inpatientSurgeryCatalogSchema.parse({
  procedures: [
    ['00.6600', '经皮冠状动脉腔内血管成形术[PTCA]', '介入治疗', 149, 120000],
    ['00.6600x008', '经皮冠状动脉药物球囊扩张成形术', '介入治疗', 151, 150000],
    ['36.0700', '药物洗脱冠状动脉支架置入', '介入治疗', 3966, 180000],
    ['47.0100', '腹腔镜下阑尾切除术', '手术', 6277, 200000],
    ['51.2300', '腹腔镜下胆囊切除术', '手术', 6694, 250000],
    ['53.0001', '单侧腹股沟疝修补术', '手术', 6999, 100000],
    ['88.5500', '单根导管的冠状动脉造影术', '诊断性操作', 12309, 80000],
    ['88.5600', '用两根导管的冠状动脉造影术', '诊断性操作', 12311, 90000],
  ].map(([code, display, category, row, price], index) => ({ id: `hospital-surgery-${index + 1}`, version: 1,
    coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code, display, category,
      releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://wst.hainan.gov.cn/swjw/xxgk/0200/0202/202006/P020200617426075784563.xlsx',
      sourceSha256: '1dd3bbbca436ab5c6b1c7a16a8ef5bcb619fe1b241be35bb9130476d917c053d', sourceLocator: `3.0!A${row}:E${row}` },
    chargeDefinition: { id: `hospital-charge-surgery-${index + 1}`, priceFen: price, unit: '次', synthetic: true, trigger: 'execution' } })),
  materials: [
    { id: 'hospital-material-suture', version: 1, display: '合成演示缝合材料', chargeDefinition: { id: 'hospital-charge-material-suture', priceFen: 2000, unit: '包', synthetic: true, trigger: 'execution' } },
    { id: 'hospital-material-catheter', version: 1, display: '合成演示导管', chargeDefinition: { id: 'hospital-charge-material-catheter', priceFen: 5000, unit: '根', synthetic: true, trigger: 'execution' } },
    ...cardiovascularMaterials,
  ],
})
