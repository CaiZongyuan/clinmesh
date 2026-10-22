import { describe, expect, it } from 'vitest'
import { extractOfficialMembers } from '../src/infrastructure/reference-data/drg-opendrg-extract.ts'

/** 从 OpenDRG chs_drg_30 官方分组器 JS 真实截取的三类判定片段（EZ1 内科 / FC1 手术 / AC1_1 组合手术）。 */
const sampleJs = [
  // 内科：主诊断数组 + 匹配规则「主诊断匹配」
  'return ["A19.800","B33.400x001+J17.1*","E32.000","U07.000"].includes(x.zdList[0])){Q("符合EZ1入组条件，匹配规则：主诊断匹配");let C=new s;return C.EZ13_group(x)?"EZ13":C.EZ15_group(x)?"EZ15":""}return""}(x))?C:void Q("不符合MDCE的ADRG入组条件")',
  // 手术：主手术位数组 + 匹配规则「主手术匹配」
  'function(x){return x.ssList.length>0&&["36.1000x002","36.2x00","37.1100x007"].includes(x.ssList[0])?(Q("符合FC1入组条件，匹配规则：主手术匹配"),(new L).FC19_group(x)?"FC19":""):""}(x)',
  // 组合手术：主手术 + 其他手术条件（首版不进参数表，只计数）
  'return x.ssList.length>1&&["55.6100","55.6901"].includes(x.ssList[0])&&G(x.ssList.slice(1),["52.8000","52.8200","52.8300"])?(Q("符合AC1_1入组条件，匹配规则：主要手术或操作+其他手术或操作"),(new E).AC19_group(x)?"AC19":""):""}(x))',
].join('\n')

describe('官方分组器 JS 文本 → 官方成员表提取（纯文本解析，不执行 JS）', () => {
  it('提取内科主诊断成员与手术主操作成员', () => {
    const result = extractOfficialMembers(sampleJs)
    expect(result.medical.EZ1).toContain('B33.400x001+J17.1*')
    expect(result.medical.EZ1).toContain('U07.000')
    expect(result.surgical.FC1).toContain('36.2x00')
    expect(result.surgical.FC1).not.toContain('52.8000')
  })

  it('组合手术判定不进成员表，但按 ADRG 归并计数报告', () => {
    const result = extractOfficialMembers(sampleJs)
    expect(result.surgical.AC1).toBeUndefined()
    expect(result.stats.comboOperationAdrgs).toEqual(['AC1'])
    expect(result.stats.medicalAdrgCount).toBe(1)
    expect(result.stats.surgicalAdrgCount).toBe(1)
  })
})
