import { describe, expect, it } from 'vitest'
import type { DrgGroupingInput } from '@clinmesh/contracts/drg'
import { drgProgramSchema } from '@clinmesh/contracts/drg-program'
import { compileDrgProgram } from '../src/infrastructure/reference-data/drg-program-compiler.ts'
import { evaluateDrgProgram } from '../src/application/drg-program.ts'

const input: DrgGroupingInput = {
  diagnoses: [{ code: 'D1', role: 'main' }], operations: [], gender: 'male', ageYears: 50,
  ageDays: null, birthWeightGrams: null, dischargeMode: '1', inpatientDays: 2,
}

const programSource = `
const CC={}, MCC={}, CCE={}, SS_VALID=[];
class Groups { AA19_group(x) { return true } }
function group_record(x) {
  return function(x) {
    return ['D1'].includes(x.zdList[0]) ? ((new Groups).AA19_group(x) ? 'AA19' : '') : ''
  }(x)
}`

function source(body: string, methods: string, extra = '', parameters = 'const CC={}, MCC={}, CCE={}, SS_VALID=[];'): string {
  return `${parameters} ${extra} class Groups { ${methods} }
    function group_record(x) { return function(x) { if(!['D1','OTHER'].includes(x.zdList[0])) return ''; ${body} }(x) }`
}

describe('固定版本声明式 DRG 条件程序', () => {
  it('从原程序提取条件并通过分组公开接口返回可解释结果', () => {
    const program = compileDrgProgram(programSource)
    const result = evaluateDrgProgram(program, input)
    expect(result).toMatchObject({ status: 'grouped', drgCode: 'AA19', adrgCode: 'AA1', mdcCode: 'MDCA' })
    expect(evaluateDrgProgram(program, { ...input, diagnoses: [{ code: 'D2', role: 'main' }] }))
      .toMatchObject({ status: 'ungroupable', drgCode: null })
  })

  it('联合操作必须保留主次顺序并优先于单一主操作', () => {
    const program = compileDrgProgram(source(`
      if (x.ssList.length>1&&['OP1'].includes(x.ssList[0])&&G(x.ssList.slice(1),['OP2'])) return (new Groups).AC19_group(x)?'AC19':'';
      if (['OP1'].includes(x.ssList[0])) return (new Groups).AC29_group(x)?'AC29':'';
      return ''`, 'AC19_group(x){return true} AC29_group(x){return true}'))
    expect(evaluateDrgProgram(program, { ...input, operations: [{ code: 'OP1', primary: true }, { code: 'OP2', primary: false }] }).drgCode).toBe('AC19')
    expect(evaluateDrgProgram(program, { ...input, operations: [{ code: 'OP2', primary: true }, { code: 'OP1', primary: false }] }).status).toBe('ungroupable')
    expect(evaluateDrgProgram(program, { ...input, operations: [{ code: 'OP1', primary: true }] }).drgCode).toBe('AC29')
  })

  it('婴儿日龄与出生体重参与条件，缺少必需输入不能取得兜底组', () => {
    const program = compileDrgProgram(source(`
      if (x.age==0&&x.ageDay<=28&&G(x.zdList,['D1'])) {
        if (x.weight<1000) return (new Groups).PS19_group(x)?'PS19':'';
        if (x.weight<1500) return (new Groups).PS29_group(x)?'PS29':'';
      }
      return ''`, 'PS19_group(x){return true} PS29_group(x){return true}'))
    const infant = { ...input, ageYears: 0, ageDays: 28, birthWeightGrams: 999 }
    expect(evaluateDrgProgram(program, infant).drgCode).toBe('PS19')
    expect(evaluateDrgProgram(program, { ...infant, birthWeightGrams: 1000 }).drgCode).toBe('PS29')
    expect(evaluateDrgProgram(program, { ...infant, ageDays: 29 }).status).toBe('ungroupable')
    expect(evaluateDrgProgram(program, { ...infant, ageDays: null })).toMatchObject({ status: 'invalid-input', drgCode: null })
    expect(evaluateDrgProgram(program, { ...infant, birthWeightGrams: null })).toMatchObject({ status: 'invalid-input', drgCode: null })
  })

  it('终端年龄条件取自原谓词并按原调用顺序执行', () => {
    const program = compileDrgProgram(source(`let C=new Groups; return C.BT3C_group(x)?'BT3C':C.BT3H_group(x)?'BT3H':C.BT35_group(x)?'BT35':''`,
      'BT3C_group(x){return x.age<=6} BT3H_group(x){return x.age>=70} BT35_group(x){return true}'))
    expect(evaluateDrgProgram(program, { ...input, ageYears: 6 }).drgCode).toBe('BT3C')
    expect(evaluateDrgProgram(program, { ...input, ageYears: 7 }).drgCode).toBe('BT35')
    expect(evaluateDrgProgram(program, { ...input, ageYears: 70 }).drgCode).toBe('BT3H')
  })

  it('来源入口日志只解释为候选检查，不冒充已满足条件或具体编码命中', () => {
    const program = compileDrgProgram(source(`
      Q('符合MDCA入组条件，匹配规则：存在手术（仅主手术）');
      Q('符合MDCP入组条件，匹配规则：婴儿');
      return (new Groups).PV15_group(x)?'PV15':''`, 'PV15_group(x){return true}'))
    const result = evaluateDrgProgram(program, { ...input, ageYears: 0, ageDays: 365 })
    expect(result).toMatchObject({ status: 'grouped', mdcCode: 'MDCP', adrgCode: 'PV1', drgCode: 'PV15' })
    expect(result.steps.find(step => step.basis.includes('MDCA'))).toEqual({
      stage: 'mdc', basis: '检查候选分支 MDCA，匹配规则：存在手术（仅主手术）', matchedCode: null, result: '检查候选 MDCA',
    })
  })

  it('主诊断排除表保留 CC/MCC 优先级和完整诊断预处理语义', () => {
    const program = compileDrgProgram(source(`let C=new Groups;return C.BR11_group(x)?'BR11':C.BR13_group(x)?'BR13':C.BR15_group(x)?'BR15':''`,
      'BR11_group(x){return x.zdList.length>1&&x.mccList.length>0} BR13_group(x){return x.zdList.length>1&&(x.mccList.length>0||x.ccList.length>0)} BR15_group(x){return true}', '',
      `const CC={'CC1':'A'}, MCC={'MCC1':'A','MCC2':'B'}, CCE={'D1':'A'}, SS_VALID=[];`))
    const withSecondary = (code: string) => ({ ...input, diagnoses: [...input.diagnoses, { code, role: 'secondary' as const }] })
    expect(evaluateDrgProgram(program, withSecondary('MCC1')).drgCode).toBe('BR15')
    expect(evaluateDrgProgram(program, withSecondary('MCC1')).steps[0]?.basis).toContain('主诊断排除组：A；MCC 0 项；CC 0 项；按排除组忽略 1 项（MCC1）')
    expect(evaluateDrgProgram(program, withSecondary('CC1')).drgCode).toBe('BR15')
    expect(evaluateDrgProgram(program, withSecondary('MCC2')).drgCode).toBe('BR11')
    expect(evaluateDrgProgram(program, withSecondary('OTHER')).drgCode).toBe('BR15')
    expect(evaluateDrgProgram(program, withSecondary('toString'))).toMatchObject({ status: 'ungroupable', reason: expect.stringContaining('coding-incompatible') })
  })

  it('星号组合编码保持源字典的整码匹配，不凭名称或拆分码推断', () => {
    const program = compileDrgProgram(programSource.replace("'D1'", "'D1+S1*'"))
    expect(evaluateDrgProgram(program, { ...input, diagnoses: [{ code: 'D1+S1*', role: 'main' }] }).drgCode).toBe('AA19')
    expect(evaluateDrgProgram(program, { ...input, diagnoses: [{ code: 'D1', role: 'main' }, { code: 'S1', role: 'secondary' }] }).status).toBe('ungroupable')
  })

  it('拒绝源码中未实现的条件及含副作用的实例构造', () => {
    expect(() => compileDrgProgram(programSource.replace("['D1'].includes(x.zdList[0])", 'x.dept===1'))).toThrow('未解析 DRG 条件')
    expect(() => compileDrgProgram(programSource.replace('AA19_group(x) { return true }', 'constructor(){external()} AA19_group(x) { return true }'))).toThrow('未解析 DRG 条件')
  })

  it('装载合同拒绝缺失的条件引用与循环调用', () => {
    const program = compileDrgProgram(programSource)
    expect(() => drgProgramSchema.parse({ ...program, tables: {} })).toThrow('成员表')
    expect(() => drgProgramSchema.parse({ ...program, functions: {
      ...program.functions, [program.entry]: [{ kind: 'return', value: { kind: 'call', id: program.entry } }],
    } })).toThrow('循环')
  })

  it('机器人操作只检查副操作，产科严重条件独立于普通 CC/MCC 条件', () => {
    const robot = compileDrgProgram(source(`let C=new Groups;return C.EB10_group(x)?'EB10':C.EB19_group(x)?'EB19':''`,
      'EB10_group(x){return x.ssList.length>0&&t(x.ssList)} EB19_group(x){return true}',
      'const M=["17.4100"];function t(x){if(x.length>1)for(let C of x.slice(1))if(M.includes(C))return!0;return!1}',
      'const CC={}, MCC={}, CCE={}, SS_VALID=["OP1"];'))
    expect(evaluateDrgProgram(robot, { ...input, operations: [{ code: 'OP1', primary: true }, { code: '17.4100', primary: false }] }).drgCode).toBe('EB10')
    expect(evaluateDrgProgram(robot, { ...input, operations: [{ code: '17.4100', primary: true }] }).drgCode).toBe('EB19')
    const obstetric = compileDrgProgram(source(`let C=new Groups;return C.OB11_group(x)?'OB11':C.OB15_group(x)?'OB15':''`,
      'OB11_group(x){return O(x.zdList)||x.mccList.length>0} OB15_group(x){return true}',
      'const D=["D1"];function O(x){return!!(x.length>0&&D.includes(x[0]))}'))
    expect(evaluateDrgProgram(obstetric, { ...input, gender: 'female' }).drgCode).toBe('OB11')
    expect(evaluateDrgProgram(obstetric, { ...input, gender: 'female', diagnoses: [{ code: 'OTHER', role: 'main' }] }).drgCode).toBe('OB15')
  })

  it('未兼容的次诊断和操作编码不能被忽略后返回成功', () => {
    const program = compileDrgProgram(programSource)
    expect(evaluateDrgProgram(program, { ...input, diagnoses: [...input.diagnoses, { code: 'UNKNOWN-DX', role: 'secondary' }] }))
      .toMatchObject({ status: 'ungroupable', drgCode: null, reason: expect.stringContaining('coding-incompatible') })
    expect(evaluateDrgProgram(program, { ...input, operations: [{ code: 'UNKNOWN-OP', primary: true }] }))
      .toMatchObject({ status: 'ungroupable', drgCode: null, reason: expect.stringContaining('coding-incompatible') })
  })
})
