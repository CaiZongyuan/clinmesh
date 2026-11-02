import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareDrgRulesPackage } from '../../src/infrastructure/reference-data/drg-rules-prepare.ts'
import type { PciPaymentDrgFixture } from './pci-payment-drg.ts'
import { syntheticDrgIdentity, syntheticDrgSource } from './drg-synthetic-program.ts'

/** 仅替换临时测试规则装配；病例、材料和建议仍走真实 HTTP。 */
export async function setInpatientCostRules(fixture: PciPaymentDrgFixture,
  status: 'rules-unavailable' | 'grouping-incomplete' | 'reference-missing') {
  if (status === 'rules-unavailable') delete fixture.options.drgRulesDirectory
  else {
    const directory = join(fixture.directory, status)
    await mkdir(directory)
    const groups = [{ level: 'MDC', code: 'MDCR', name: '合成医保说明验证', parentCode: null },
      { level: 'ADRG', code: 'RA1', name: '合成缺项验证组', parentCode: 'MDCR' },
      { level: 'DRG', code: 'RA16', name: '合成无支付参数组', parentCode: 'RA1' }]
    const jsText = syntheticDrgSource(status === 'grouping-incomplete' ? 'I10.x09' : 'I25.103', 'RA16')
    const tables = { CC: {}, MCC: {}, CCE: {} }
    const files = prepareDrgRulesPackage({ groups, jsText, complicationTables: tables,
      input: syntheticDrgIdentity(jsText, groups, tables), releaseId: 'synthetic-cost-fallback', sourceVersion: status })
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content)
    fixture.options.drgRulesDirectory = directory
  }
  await fixture.restart()
}
