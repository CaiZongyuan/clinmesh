import { createHash } from 'node:crypto'

/** 自编合成原程序；组名刻意不表达谓词，防止按名称猜测计算条件。 */
export function syntheticDrgSource(diagnosis = 'I10.x09', drgCode = 'RA15', operationCode?: string): string {
  return `const CC={},MCC={},CCE={},SS_VALID=[];
class Groups { ${drgCode}_group(x) { return true } ${operationCode === undefined ? '' : 'RA25_group(x) { return true }'} }
function group_record(x) {
  return function(x) {
    Q('符合MDCR入组条件，匹配规则：合成输入');
    ${operationCode === undefined ? '' : `if ([${JSON.stringify(operationCode)}].includes(x.ssList[0])) { Q('符合RA2入组条件，匹配规则：主手术匹配'); return (new Groups).RA25_group(x) ? 'RA25' : '' }`}
    return [${JSON.stringify(diagnosis)}].includes(x.zdList[0])
      ? (Q('符合${drgCode.slice(0, 3)}入组条件，匹配规则：主诊断匹配'), (new Groups).${drgCode}_group(x) ? ${JSON.stringify(drgCode)} : '')
      : '0000'
  }(x)
}`
}

export function syntheticDrgIdentity(jsText: string, groups: readonly unknown[], tables: unknown) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return { openDrgJsSha256: hash(jsText), openDrgTablesSha256: hash(JSON.stringify(tables)),
    r3GroupsSha256: hash(`${groups.map(row => JSON.stringify(row)).join('\n')}\n`) }
}
