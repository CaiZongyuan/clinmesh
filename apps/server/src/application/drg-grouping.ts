import type { DrgGroupingInput, DrgGroupingResult, DrgRules } from '@clinmesh/contracts/drg'
import { evaluateDrgProgram } from './drg-program.ts'

/** 固定规则纯函数；规则仅在装载边界校验，业务事实不由分组修改。 */
export function groupDrgCase(rules: DrgRules, rawInput: DrgGroupingInput): DrgGroupingResult {
  return evaluateDrgProgram(rules.program, rawInput)
}
