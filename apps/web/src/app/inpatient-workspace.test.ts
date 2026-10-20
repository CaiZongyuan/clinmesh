import { expect, it } from 'vitest'
import { yuanToFen } from './inpatient-workspace.tsx'

it('预交金按十进制元精确转为整数分并拒绝无效金额', () => {
  expect(yuanToFen('1000.01')).toBe(100001)
  expect(yuanToFen('0.29')).toBe(29)
  expect(yuanToFen('0')).toBe(0)
  expect(yuanToFen('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER)
  for (const value of ['', '-1', '1.001', 'NaN', '1e3', '9007199254740992', '90071992547409.92']) {
    expect(yuanToFen(value)).toBeUndefined()
  }
})
