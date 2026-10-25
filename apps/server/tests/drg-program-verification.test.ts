import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDrgProgramOracle, createDrgSourceVerificationCases, inspectDrgProgramSource,
  verifyDrgProgramCases } from '../src/infrastructure/reference-data/drg-program-verification.ts'

const syntheticSource = '(self.webpackChunkpack_drg_ce=self.webpackChunkpack_drg_ce||[]).push([[3258],{3258(module){module.exports={group_record_str(value){const values=value.split(",");return [{},{status:"分组成功",mdc:"MDCA",adrg:"AA1",drg:values[2]>=70?"AA1G":"AA19",messages:["合成来源"]}]}}}}]);'
const sourceSha256 = createHash('sha256').update(syntheticSource).digest('hex')
const input = { diagnoses: [{ code: 'SYN.DX', role: 'main' as const }], operations: [], gender: 'male' as const,
  ageYears: 70, ageDays: null, birthWeightGrams: null, dischargeMode: '1', inpatientDays: 5 }

describe('DRG 独立原程序对照', () => {
  it('拒绝来源字节变化，不能只登记调用方声称的哈希', () => {
    expect(() => createDrgProgramOracle(syntheticSource, '0'.repeat(64))).toThrow(/SHA-256/)
  })

  it('预期来自原程序，并保留每例输入、解释与差异定位', () => {
    const oracle = createDrgProgramOracle(syntheticSource, sourceSha256)
    const report = verifyDrgProgramCases({ sourceSha256, oracle, cases: [{ id: 'age-boundary', input,
      inputSource: '合成固定输入；70 岁边界', sourceOffset: 0, conditionKinds: ['age-years'],
      expected: { status: 'grouped', drgCode: 'AA1G' } }], evaluate: () => ({ status: 'grouped', drgCode: 'AA19',
        mdcCode: 'MDCA', adrgCode: 'AA1', reason: null, steps: [] }) })
    expect(report.mismatchCount).toBe(1)
    expect(report.cases[0]).toMatchObject({ id: 'age-boundary', input, expected: { drgCode: 'AA1G' },
      actual: { drgCode: 'AA19' }, differences: ['drgCode'] })
    expect(report.coverage.conditionKinds).toEqual(['age-years'])
  })

  it('人工预期与原程序不一致也报告，避免源程序对照替代独立解释', () => {
    const report = verifyDrgProgramCases({ sourceSha256, oracle: createDrgProgramOracle(syntheticSource, sourceSha256),
      cases: [{ id: 'independent-expectation', input, inputSource: '合成反例', sourceOffset: 0, conditionKinds: [],
        expected: { status: 'grouped', drgCode: 'AA19' } }], evaluate: () => ({ status: 'grouped', drgCode: 'AA1G',
          mdcCode: 'MDCA', adrgCode: 'AA1', reason: null, steps: [] }) })
    expect(report.mismatchCount).toBe(1)
    expect(report.cases[0]?.differences).toEqual(['independentExpected.drgCode'])
  })

  it('逐个登记未被选中的源终端，不能仅凭函数总数宣称覆盖', () => {
    const report = verifyDrgProgramCases({ sourceSha256, oracle: createDrgProgramOracle(syntheticSource, sourceSha256),
      cases: [{ id: 'one-terminal', input, inputSource: '合成单组', sourceOffset: 0, conditionKinds: [] }],
      evaluate: () => ({ status: 'grouped', drgCode: 'AA1G', mdcCode: 'MDCA', adrgCode: 'AA1', reason: null, steps: [] }),
      inventory: { routes: [], terminals: [{ code: 'AA1G', offset: 1, predicate: 'x.age>=70' }, { code: 'AB19', offset: 2, predicate: '!0' }] } })
    expect(report.mismatchCount).toBe(0)
    expect(report.coverage.unselectedDrgCodes).toEqual(['AB19'])
    expect(report.coverage.terminalPredicateClasses.find(entry => entry.predicate === '!0')?.selectedCodes).toEqual([])
  })

  it('从源成员和边界生成固定合成输入，记录来源偏移并保持主次顺序', () => {
    const source = 'class A{AA19_group(x){return !0}AA1G_group(x){return x.age>=70}};(function(x){return x.ssList.length>1&&["OP.MAIN"].includes(x.ssList[0])&&G(x.ssList.slice(1),["OP.OTHER"])?(Q("符合AA1入组条件，匹配规则：主要手术或操作+其他手术或操作"),"AA19"):""})(input)'
    const inventory = inspectDrgProgramSource(source)
    expect(inventory.terminals.map(entry => entry.code)).toEqual(['AA19', 'AA1G'])
    const cases = createDrgSourceVerificationCases(source, { CC: {}, MCC: {}, CCE: {} })
    const baseline = cases.find(entry => entry.id.endsWith(':base'))
    expect(baseline?.input.operations).toEqual([{ code: 'OP.MAIN', primary: true }, { code: 'OP.OTHER', primary: false }])
    expect(baseline?.sourceOffset).toBe(source.indexOf('function(x)'))
    expect(cases.some(entry => entry.input.ageYears === 69)).toBe(true)
    expect(cases.some(entry => entry.input.ageYears === 70)).toBe(true)
  })

  it('仅在全部 MDC 主诊断被更早的恒真终端入口包含时证明路由遮蔽', () => {
    const source = 'class S{AA19_group(x){return!0}};(function(x){let A=["DX.MAIN"];return A.includes(x.zdList[0])?(Q("符合MDCA入组条件，匹配规则：主诊断匹配"),(function(x){if(["DX.MAIN"].includes(x.zdList[0])){Q("符合AA1入组条件，匹配规则：主诊断匹配");let C=new S;return C.AA19_group(x)?"AA19":""}return""})(x)||(function(x){if(["DX.OTHER"].includes(x.zdList[1])){Q("符合AA2入组条件，匹配规则：其他诊断匹配");return"AA29"}return""})(x)):""})(input)'
    expect(inspectDrgProgramSource(source).shadowedRoutes).toMatchObject([{ code: 'AA2', shadowedBy: 'AA1', mainDiagnosisCount: 1 }])
    const guarded = source.replace('if(["DX.MAIN"].includes(x.zdList[0]))', 'if(x.age>=70&&["DX.MAIN"].includes(x.zdList[0]))')
    expect(inspectDrgProgramSource(guarded).shadowedRoutes).toEqual([])
  })
})
