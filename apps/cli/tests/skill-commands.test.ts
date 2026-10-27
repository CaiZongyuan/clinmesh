import { readdir, readFile as readTextFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { excludedHisRoutes, getHisOperation, listHisOperations } from '@clinmesh/contracts/his-operations'
import { type Command, type Option } from 'commander'
import { createCliProgram } from '../src/cli.ts'

async function readFile(path: string, encoding: 'utf8') {
  return (await readTextFile(path, encoding)).replaceAll('\r\n', '\n')
}

const expectedSkills = [
  'clinmesh-administrator',
  'clinmesh-billing',
  'clinmesh-doctor',
  'clinmesh-fhir',
  'clinmesh-inpatient',
  'clinmesh-pharmacy',
  'clinmesh-registration',
  'clinmesh-shared',
  'clinmesh-triage',
]

it('DRG示例绑定预览指纹，写入结果保留可恢复的Command回执', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [path, id] of [
    ['drg-followup', 'inpatient.drg.followup.read'], ['drg-followup-start', 'inpatient.drg.followup.start'], ['drg-followup-stop', 'inpatient.drg.followup.stop'],
    ['drg-pregroup', 'inpatient.drg.pregroup'], ['drg-simulate', 'inpatient.drg.simulate'],
    ['drg-reserve-material', 'inpatient.drg.reservation.create'], ['drg-release-reservation', 'inpatient.drg.reservation.release'],
    ['drg-payer-review-preview', 'inpatient.drg.payer.review.preview'], ['drg-payer-review', 'inpatient.drg.payer.review'],
  ]) {
    expect(inspectExample(program, commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path} `))!).operation?.id).toBe(id)
  }
  const examples = [...skill.matchAll(/```json\n([\s\S]+?)\n```/g)].map(match => JSON.parse(match[1]!))
  const reviewed = examples.find(input => input.encounterVersion && input.expectedFingerprint)
  const payer = getHisOperation('inpatient.drg.payer.review')
  expect(payer.input.safeParse(reviewed).success).toBe(true)
  expect(payer.input.safeParse({ ...reviewed, expectedFingerprint: undefined }).success).toBe(false)
  for (const [id, data] of [
    ['inpatient.drg.reservation.create', { admissionId: 'synthetic-admission', encounterVersion: '2', reservations: [] }],
    ['inpatient.drg.reservation.release', { admissionId: 'synthetic-admission', encounterVersion: '2', reservations: [] }],
    ['inpatient.drg.payer.review', { admissionId: 'synthetic-admission', reviews: [] }],
  ] as const) {
    const operation = getHisOperation(id)
    expect(operation.output.safeParse({ auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data }).success).toBe(true)
    expect(operation.output.safeParse(data).success).toBe(false)
  }
  expect(skill).toContain('INPATIENT_DRG_EVALUATION_STALE')
  expect(skill).toContain('INPATIENT_DRG_PAYER_PREVIEW_STALE')
  expect(skill).toContain('caseSummary')
  expect(skill).toContain('paymentEstimate')
  expect(skill).toContain('estimateDifferenceFen')
  expect(skill).toContain('primarySurgeryRequestId')
  expect(skill).toContain('INPATIENT_DRG_PLAN_CONFLICT')
  expect(getHisOperation('inpatient.drg.simulate').input.parse({ admissionId: 'synthetic-admission',
    draft: { primarySurgeryRequestId: 'synthetic-plan' } })).toMatchObject({ draft: { primarySurgeryRequestId: 'synthetic-plan' } })
  expect(getHisOperation('inpatient.drg.simulate').version).toBe(3)
  expect(getHisOperation('inpatient.drg.pregroup').version).toBe(4)
  expect(getHisOperation('inpatient.drg.payer.review.preview').version).toBe(2)
  expect(payer.version).toBe(4)
  expect(getHisOperation('inpatient.drg.payer.reviews').version).toBe(2)
})

it('术中逐笔示例绑定同一手术、预留版本与不可改写的更正来源', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [path, id] of [['start-surgery', 'inpatient.surgery.start'], ['record-surgery-material', 'inpatient.surgery.record-material'],
    ['correct-surgery-material', 'inpatient.surgery.correct-material'], ['complete-surgery', 'inpatient.surgery.complete']]) {
    expect(inspectExample(program, commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path} `))!).operation?.id).toBe(id)
  }
  const common = { admissionId: 'synthetic-admission', requestId: 'synthetic-request', expectedRequestVersion: 4, executionId: 'synthetic-execution', note: '合成逐笔确认' }
  const record = getHisOperation('inpatient.surgery.record-material')
  expect(record.input.safeParse({ ...common, material: { materialId: 'synthetic-material', catalogVersion: 1, quantity: 1, reservationId: 'synthetic-reservation' } }).success).toBe(false)
  expect(record.input.safeParse({ ...common, material: { materialId: 'synthetic-material', catalogVersion: 1, quantity: 1, reservationId: 'synthetic-reservation', expectedReservationVersion: 2 } }).success).toBe(true)
  expect(getHisOperation('inpatient.surgery.correct-material').input.safeParse({ ...common, materialUseId: 'synthetic-use', amountFen: 1 }).success).toBe(false)
  expect(skill).toContain('materialHistory')
  expect(skill).toContain('remainingQuantity')
  expect(skill).toContain('releaseReason')
})

it('术后核查示例只处理对应岗位待办并保留版本、依据与回执', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [path, id] of [['drg-review', 'inpatient.drg.review.read'], ['drg-review-todo', 'inpatient.drg.review.todo.act'], ['drg-review-handoff', 'inpatient.drg.review.handoff']]) {
    expect(inspectExample(program, commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path} `))!).operation?.id).toBe(id)
  }
  const todo = getHisOperation('inpatient.drg.review.todo.act')
  const examples = [...skill.matchAll(/```json\n([\s\S]+?)\n```/g)].map(match => JSON.parse(match[1]!))
  const example = examples.find(item => item.todoId)
  expect(todo.input.safeParse(example).success).toBe(true)
  expect(todo.input.safeParse({ ...example, status: 'resolved' }).success).toBe(false)
  expect(todo.input.safeParse({ ...example, expectedTodoVersion: undefined }).success).toBe(false)
  expect(todo.input.safeParse({ ...example, note: '' }).success).toBe(false)
  expect(todo.roles).toEqual(['inpatient-doctor', 'medical-records', 'cashier'])
  expect(getHisOperation('inpatient.drg.review.handoff').roles).not.toContain('cashier')
  expect(skill).toContain('INPATIENT_DRG_TODO_UNRESOLVED')
})

it('住院共享目录检索示例提供受控分页并保留真实来源', async () => {
  const operation = getHisOperation('inpatient.catalog.search')
  expect(operation.input.parse({ kind: 'medication', source: 'reference' })).toMatchObject({
    kind: 'medication', source: 'reference', page: 1, pageSize: 20,
  })
  expect(operation.input.safeParse({ kind: 'medication', source: 'reference', pageSize: 51 }).success).toBe(false)
  expect(operation.input.safeParse({ kind: 'medication', source: 'reference', sql: 'SELECT *' }).success).toBe(false)
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  const line = commandLines(skill).find(line => line.startsWith('clinmesh inpatient catalog-search '))!
  expect(inspectExample(program, line).operation?.id).toBe(operation.id)
  expect(operation.roles).toEqual(['inpatient-doctor'])
})

it('PCI 资料准备示例限定当前场景及管理员并保留原幂等意图', async () => {
  const prepare = getHisOperation('inpatient.pci-data.prepare')
  expect(prepare.roles).toEqual(['administrator'])
  expect(prepare.requirements).toEqual({ expectedVersions: true, idempotency: 'required' })
  expect(prepare.input.parse({ expectedEpoch: 'epoch-1' })).toEqual({ expectedEpoch: 'epoch-1' })
  expect(prepare.input.safeParse({ expectedEpoch: 'epoch-1', patientId: 'synthetic-patient' }).success).toBe(false)
  expect(getHisOperation('inpatient.pci-data.read').roles).toEqual(['administrator', 'inpatient-doctor'])
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [command, id] of [['pci-data', 'inpatient.pci-data.read'], ['prepare-pci-data', prepare.id]]) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${command}`))!
    expect(inspectExample(program, line).operation?.id).toBe(id)
  }
  expect(skill).toContain('INPATIENT_PCI_EPOCH_CONFLICT')
})

it('固定 PCI 来源与直接住院示例使用窄合同并各自恢复原回执', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const admin = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-administrator/SKILL.md'), 'utf8')
  const registration = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-registration/SKILL.md'), 'utf8')
  const prepare = getHisOperation('admin.pci-case.prepare'), start = getHisOperation('registration.synthetic-case.start-inpatient')
  expect(prepare.input.safeParse({ expectedEpoch: 'epoch-1', bundle: {} }).success).toBe(false)
  expect(prepare.roles).toEqual(['administrator'])
  expect(start.roles).toEqual(['registrar'])
  expect(start.input.parse({ caseId: 'synthetic-case', activeBriefRevision: 1, expectedCaseRevision: 2, expectedEpoch: 'epoch-1', wardId: 'ward-general' })).toBeDefined()
  for (const [skill, prefix, id] of [[admin, 'clinmesh admin pci-case prepare ', prepare.id],
    [registration, 'clinmesh registration synthetic-case start-inpatient ', start.id]]) {
    expect(inspectExample(program, commandLines(skill!).find(line => line.startsWith(prefix!))!).operation?.id).toBe(id)
    expect(skill).toContain(`--operation-id ${id}`)
  }
})

it('住院退款示例及Catalog保留单笔一千万元上限', async () => {
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  const examples = [...skill.matchAll(/```json\n([\s\S]+?)\n```/g)].map(match => JSON.parse(match[1]!))
  const input = examples.find(value => value.sourceId && !value.adjustmentId)
  const operation = getHisOperation('inpatient.refund.preview')
  expect(operation.input.safeParse(input).success).toBe(true)
  expect(input.amountFen).toBe(1_000_000_000)
  expect(operation.input.safeParse({ ...input, amountFen: 1_000_000_001 }).success).toBe(false)
  const response = { auditId: 'synthetic-audit', requestId: 'synthetic-request', effects: [], warnings: [], data: {
    admissionId: 'synthetic-admission', previewId: 'synthetic-preview', commitToken: 'synthetic-token', sourceId: 'synthetic-payment',
    sourceKind: 'inpatient-deposit', amountFen: 1_000_000_000, expectedOutcome: 'success', expiresAt: '2026-10-23T08:00:00Z',
  } }
  expect(operation.output.safeParse(response).success).toBe(true)
  expect(operation.output.safeParse({ ...response, data: { ...response.data, amountFen: 1_000_000_001 } }).success).toBe(false)
  expect(operation.summary).toContain('单笔上限1000万元')
  expect(skill).toContain('大额须分多次退')
})

it('keeps later inpatient insurance compensation and reviewed replacement commands aligned', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const action of ['cancel', 'preview', 'confirm']) {
    const id = `inpatient.financial.insurance.${action}`
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh inpatient financial-insurance ${action} `))!
    const operation = getHisOperation(id)
    expect(inspectExample(program, line).operation?.id).toBe(id)
    expect(operation.roles).toEqual(['cashier'])
    expect(operation.commandOperation).toBe(id)
    expect(operation.skill).toBe('clinmesh-inpatient')
    expect(operation.previewToken).toBe(action === 'confirm' ? 'required' : 'none')
  }
  for (const term of ['INPATIENT_INSURANCE_PREVIEW_STALE', 'insurance.ready', 'remainingCollectFen/remainingRefundFen', '原年度']) expect(skill).toContain(term)
})

it('住院财务人工示例显式确认并绑定高风险操作版本', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [path, id] of [
    ['adjust-finance', 'inpatient.financial.adjust'],
    ['confirm-financial-refund', 'inpatient.financial.refund.confirm'],
    ['recover-financial-refund', 'inpatient.financial.refund.recover'],
    ['confirm-financial-payment', 'inpatient.financial.payment.confirm'],
    ['recover-financial-payment', 'inpatient.financial.payment.recover'],
    ['confirm-payment', 'inpatient.payment.confirm'], ['recover-payment', 'inpatient.payment.recover'],
    ['confirm-refund', 'inpatient.refund.confirm'], ['recover-refund', 'inpatient.refund.recover'],
    ['settle', 'inpatient.discharge.settle'],
  ]) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path} `))!
    expect(line.split(/\s+/)).toContain('--yes')
    expect(inspectExample(program, line).operation).toMatchObject({ id, risk: 'high-risk-write', version: 2 })
  }
})

it('结算后更正示例绑定原费用、当前账目与原资金尝试', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  expect(skill).toContain('INPATIENT_FUNDS_PENDING')
  for (const id of ['refund.preview', 'refund.confirm', 'payment.preview', 'payment.confirm']) {
    expect(getHisOperation(`inpatient.financial.${id}`).summary).toContain('INPATIENT_FUNDS_PENDING')
  }
  for (const [path, id] of [
    ['financial-adjustments', 'read'], ['adjust-finance', 'adjust'], ['preview-financial-refund', 'refund.preview'], ['confirm-financial-refund', 'refund.confirm'],
    ['recover-financial-refund', 'refund.recover'], ['preview-financial-payment', 'payment.preview'], ['confirm-financial-payment', 'payment.confirm'], ['recover-financial-payment', 'payment.recover'],
  ]) {
    const operation = getHisOperation(`inpatient.financial.${id}`)
    expect(inspectExample(program, commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path} `))!).operation?.id).toBe(operation.id)
    expect(operation.roles).toEqual(id === 'read' ? ['cashier', 'medical-records'] : ['cashier'])
    expect(operation.skill).toBe('clinmesh-inpatient')
  }
  const examples = [...skill.matchAll(/```json\n([\s\S]+?)\n```/g)].map(match => JSON.parse(match[1]!))
  for (const [id, field] of [['adjust', 'direction'], ['refund.preview', 'expectedSourceVersion'], ['payment.preview', 'tenders'], ['refund.confirm', 'commitToken'], ['refund.recover', 'expectedRefundVersion'], ['payment.recover', 'expectedPaymentVersion']]) {
    const example = examples.find(input => field! in input && (id !== 'payment.preview' || 'adjustmentId' in input))
    const parsed = getHisOperation(`inpatient.financial.${id}`).input.safeParse(example)
    expect(parsed.success, `${id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true)
  }
  const adjustment = examples.find(input => input.direction === 'decrease')
  expect(getHisOperation('inpatient.financial.adjust').input.safeParse({ ...adjustment, amountFen: -1 }).success).toBe(false)
  expect(getHisOperation('inpatient.financial.adjust').input.safeParse({ ...adjustment, encounterId: 'untrusted' }).success).toBe(false)
})

it('处方撤回操作与技能保留零支付医保分配的撤销前置条件', async () => {
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  for (const term of ['WORKFLOW_CONFLICT', 'zero fund', 'clinmesh insurance cancel']) expect(skill).toContain(term)
  for (const term of ['WORKFLOW_CONFLICT', 'zero-benefit', 'insurance.cancel']) expect(getHisOperation('prescription.withdraw').summary).toContain(term)
})

it('keeps unified billing and recorded payment recovery examples aligned with the cashier catalog', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-billing/SKILL.md'), 'utf8')
  for (const [prefix, id, version] of [
    ['clinmesh billing case get ', 'billing.case.get', 2],
    ['clinmesh payment preview ', 'payment.preview', 2],
    ['clinmesh payment confirm ', 'payment.confirm', 2],
    ['clinmesh payment recover ', 'payment.recover', 1],
    ['clinmesh billing refunds get ', 'billing.refunds.get', 1],
    ['clinmesh billing charge adjust ', 'billing.charge.adjust', 1],
    ['clinmesh refund preview ', 'refund.preview', 1],
    ['clinmesh refund confirm ', 'refund.confirm', 1],
    ['clinmesh refund recover ', 'refund.recover', 2],
    ['clinmesh insurance get ', 'insurance.get', 1],
    ['clinmesh insurance preview ', 'insurance.preview', 1],
    ['clinmesh insurance confirm ', 'insurance.confirm', 1],
    ['clinmesh insurance cancel ', 'insurance.cancel', 1],
  ] as const) {
    const line = commandLines(skill).find(line => line.startsWith(prefix))!
    const operation = getHisOperation(id)
    expect(inspectExample(program, line).operation?.id).toBe(id)
    expect(operation.version).toBe(version)
    expect(operation.skill).toBe('clinmesh-billing')
  }
  for (const id of ['payment.confirm', 'payment.recover', 'refund.confirm', 'refund.recover', 'insurance.confirm', 'insurance.cancel']) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh command receipt get --operation-id ${id} `))!
    expect(inspectExample(program, line).operation?.id).toBe('command.receipt.get')
  }
  for (const term of ['paymentsPagination', '--page-size', 'tenders', 'cash', 'bank-card', 'mobile', 'positive integer fen',
    'expectedPaymentVersion', 'ambiguous-decline', 'ambiguous-pending', 'original Command receipt',
    'Recovery queries the channel without collecting again', 'only a fully paid charge',
    'Registration charges remain unpaid and read-only']) expect(skill).toContain(term)
  for (const term of ['expectedBalanceVersion', 'annualBalances', 'INSURANCE_PREVIEW_STALE', 'not payment tenders',
    'calendar year', 'preserves later transactions and clinical progress', 'INSURANCE_FUNDS_CONFLICT', 'completed Encounter']) expect(skill).toContain(term)
  for (const id of ['insurance.preview', 'insurance.confirm']) expect(getHisOperation(id).summary).toContain('INSURANCE_FUNDS_CONFLICT')
  for (const term of ['current-Epoch human cashier', 'completed Scenario Run', 'closed Run and completed Agent Grant are rejected']) expect(skill).toContain(term)
  for (const term of ['current-Epoch human cashier', 'active/completed Scenario Run', 'closed Run and completed Agent Grant are rejected']) expect(getHisOperation('refund.recover').summary).toContain(term)
  const examples=[...skill.matchAll(/```json\n([^]*?)\n```/g)].map(match=>JSON.parse(match[1]!))
  for (const [operation, field] of [['insurance.preview', 'planCode'], ['insurance.confirm', 'commitToken'], ['insurance.cancel', 'expectedBalanceVersion']]) {
    for (const kind of ['outpatient', 'inpatient']) {
      const example = examples.find(input => input.kind === kind && field! in input)
      expect(getHisOperation(operation!).input.parse(example)).toMatchObject({ kind })
    }
  }
})

it('独立检查收费示例按原费用收款并保留取消退款与历史兼容指引', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const [billing, doctor, workflows] = await Promise.all([
    readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-billing/SKILL.md'), 'utf8'),
    readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8'),
    readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/references/clinical-workflows.md'), 'utf8'),
  ])
  const categories = commandLines(billing).filter(line => line.startsWith('clinmesh billing queue list ') && line.includes('--status pending'))
    .map(line => {
      const operation = inspectExample(program, line).operation!
      const category = line.match(/--category (\S+)/)![1]!
      expect(operation.input.parse({ category, status: 'pending' })).toMatchObject({ category, status: 'pending' })
      return category
    })
  expect(categories).toEqual(['laboratory', 'imaging', 'pathology', 'medication'])
  const examples = [...billing.matchAll(/```json\n([\s\S]+?)\n```/g)].map(match => JSON.parse(match[1]!))
  for (const [id, field] of [['payment.preview', 'category'], ['payment.confirm', 'previewId'], ['payment.recover', 'expectedPaymentVersion']] as const) {
    const example = examples.find(input => input.chargeItemId && field in input)
    const operation = getHisOperation(id)
    expect(operation.input.parse(example)).toMatchObject({ chargeItemId: '<charge-item-id>' })
    expect(operation.input.safeParse({ ...example, chargeItemId: undefined }).success).toBe(false)
    expect(operation.input.safeParse({ ...example, requestId: 'substitute-request' }).success).toBe(false)
    expect(operation.requirements).toEqual({ expectedVersions: true, idempotency: 'required' })
    expect(operation.roles).toEqual(['cashier'])
  }
  for (const kind of ['laboratory', 'imaging', 'pathology']) {
    const issue = getHisOperation(`encounter.${kind}-request.issue`)
    const cancel = getHisOperation(`${kind}-request.cancel`)
    const draftInput = { encounterId: 'encounter', encounterVersion: '1', expectedDraftVersion: 1 }
    expect(issue.input.parse(draftInput)).toEqual(draftInput)
    expect(issue.input.safeParse({ ...draftInput, reviewedService: { id: 'substitute', version: 1, outpatientBilling: null } }).success).toBe(false)
    expect(issue.summary).toContain('CATALOG_CONFLICT')
    expect(issue.summary).toContain('保留草稿')
    expect(cancel.summary).toContain('insurance.cancel')
    expect(cancel.summary).toContain('原成功交易退款')
    expect(cancel.roles).toEqual(['outpatient-doctor'])
  }
  expect(doctor).toContain('CATALOG_CONFLICT')
  expect(doctor).toContain('reviewedService')
  const confirmationPath = '/api/his/v1/doctor/cases/:caseId/recommendations/:kind/actions/confirm'
  expect(listHisOperations().some(operation => operation.http.path === confirmationPath)).toBe(false)
  expect(excludedHisRoutes.find(route => route.path === confirmationPath)?.reason).toContain('不提供独立 CLI 或 Agent Grant')
  for (const term of ['original `requestId`', '`chargeItemId`', 'legacy-unbilled', 'Pending cancellation refunds keep the Scenario Run active']) expect(billing).toContain(term)
  for (const term of ['CATALOG_CONFLICT', 'legacy-unbilled', 'Ordinary cancellation rejects', 'insurance.cancel', 'no second charge', 'reviewedService', 'explicitly review again', 'no CLI command or Agent Grant']) expect(workflows).toContain(term)
})

it('keeps inpatient pharmacy and charge reads and receipts aligned with role-specific contracts', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [path, id, role] of [['pharmacy-list', 'inpatient.pharmacy.list', 'pharmacist'], ['pharmacy-read', 'inpatient.pharmacy.read', 'pharmacist'], ['charges', 'inpatient.charges.read', 'cashier']] as const) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path}`))!
    expect(inspectExample(program, line).operation?.id).toBe(id)
    expect(getHisOperation(id).roles).toEqual([role])
  }
  for (const id of ['inpatient.catalog', 'inpatient.admission.list', 'inpatient.admission.read', 'inpatient.clinical.catalog', 'inpatient.clinical.read']) {
    expect(getHisOperation(id).roles).not.toContain('pharmacist')
  }
  expect(skill).toContain('inpatient.execution.dispense')
  expect(skill).toContain('inpatient.charge.reverse')
  expect(getHisOperation('inpatient.clinical.read').roles).not.toContain('cashier')
})

it('keeps registration examples and numbering recovery aligned with the command catalog', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-registration/SKILL.md'), 'utf8')
  for (const [prefix, id] of [
    ['clinmesh registration create ', 'registration.create'],
    ['clinmesh registration synthetic-case start ', 'registration.synthetic-case.start'],
  ] as const) {
    const line = commandLines(skill).find(line => line.startsWith(prefix))!
    const operation = getHisOperation(id)
    expect(inspectExample(program, line).operation?.id).toBe(id)
    expect(operation.version).toBe(2)
    for (const code of ['REGISTRATION_NUMBER_STATE_INVALID', 'REGISTRATION_NUMBER_EXHAUSTED', 'REGISTRATION_NUMBER_AUTHORITY_RETIRED']) {
      expect(operation.summary).toContain(code)
      expect(skill).toContain(code)
    }
    expect(operation.summary).toContain('administrator recovery')
  }
  expect(skill).toContain('original intent and key')
  expect(skill).toContain('`registrationNumber`')
})

it('keeps laboratory failure recovery instructions aligned with the command catalog', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  for (const path of ['cancel', 'retry-generation']) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh laboratory-request ${path} `))!
    expect(inspectExample(program, line).operation?.id).toBe(`laboratory-request.${path}`)
  }
  const retry = getHisOperation('laboratory-request.retry-generation')
  expect(retry.version).toBe(4)
  expect(retry.summary).toContain('INVESTIGATION_TRUTH_INCOMPATIBLE')
  expect(retry.summary).toContain('MODEL_OUTCOME_UNKNOWN')
  expect(skill).toContain('INVESTIGATION_TRUTH_INCOMPATIBLE')
  expect(getHisOperation('laboratory-request.cancel').summary).toContain('generation-failed')
})

it('keeps consultation recovery examples aligned with durable attempt semantics', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  const reference = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/references/clinical-workflows.md'), 'utf8')
  for (const [path, id] of [['ask', 'encounter.consultation.ask'], ['retry-reply', 'encounter.consultation.reply.retry']] as const) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh encounter consultation ${path} `))!
    const operation = getHisOperation(id)
    expect(inspectExample(program, line).operation?.id).toBe(id)
    expect(operation.version).toBe(5)
    expect(operation.summary).toContain('deadline')
    expect(operation.summary).toContain('failed or unknown')
    expect(operation.summary).toContain('without new inference')
    for (const code of ['MODEL_CONTROL_BLOCKED', 'CONSULTATION_CASE_NOT_FOUND', 'CONSULTATION_PERSONA_OUTDATED']) {
      expect(operation.summary).toContain(code)
      expect(skill).toContain(code)
    }
    expect(operation.input.safeParse({ encounterId: 'synthetic', arbitraryPayload: {} }).success).toBe(false)
  }
  expect(getHisOperation('doctor.case.get').version).toBe(15)
  expect(getHisOperation('doctor.case.get').summary).toContain('consultation.replyAttempt')
  expect(skill).toContain('consultation.replyAttempt')
  expect(skill).toContain('same ask/retry key')
  expect(skill).toContain('`blocked` reply can resume')
  expect(reference).toContain('MODEL_CONTROL_BLOCKED')
  expect(reference).toContain('never automatically resends an `unknown` request')
  expect(reference).toContain('original `deadlineAt` and model')
  expect(reference).toContain('restart does not automatically answer')
  expect(reference).toContain('Never resend the doctor message as a new intent')
  expect(reference).toContain('no published recommendation CLI command')
})

it('keeps signing review and cancellation examples aligned with the narrow operation contracts', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  const reference = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/references/clinical-workflows.md'), 'utf8')
  for (const [suffix, version] of [['preview', 5], ['commit', 4], ['cancel', 2]] as const) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh encounter clinical-document sign ${suffix}`))!
    expect(inspectExample(program, line).operation?.version).toBe(version)
  }
  const cancel = getHisOperation('encounter.clinical-document.sign.cancel')
  expect(cancel.skill).toBe('clinmesh-doctor')
  expect(cancel.commandOperation).toBe('clinical-document.cancel-sign')
  expect(cancel.summary).toContain('a valid cancel-only Agent Grant')
  expect(skill).toContain('A valid cancel-only Agent Grant')
  expect(skill).toContain('Recovery remains bound to that exact Grant')
  expect(cancel.input.safeParse({ encounterId: 'synthetic', encounterVersion: '3', previewId: 'preview' }).success).toBe(true)
  expect(cancel.input.safeParse({ encounterId: 'synthetic', encounterVersion: '3', previewId: 'preview', document: {} }).success).toBe(false)
  const commit = getHisOperation('encounter.clinical-document.sign')
  expect(commit.input.safeParse({ encounterId: 'synthetic', encounterVersion: '3', previewId: 'preview', commitToken: 'synthetic-commit-token', }).success).toBe(true)
  expect(reference).not.toContain('consultationReviewed')
  expect(reference).toContain('consultationRecording.signingPreparation')
  expect(reference).toContain('even without automatic recording')
  expect(getHisOperation('encounter.clinical-document.sign.preview').summary).toContain('even without automatic recording')
})

function commandLines(markdown: string): string[] {
  const lines = markdown.split('\n')
  const commands: string[] = []
  let bash = false
  for (const line of lines) {
    if (line.trim() === '```bash') {
      bash = true
      continue
    }
    if (line.trim() === '```') {
      bash = false
      continue
    }
    if (bash && line.trim().startsWith('clinmesh ')) commands.push(line.trim())
  }
  return commands
}

function inspectExample(program: Command, line: string) {
  const words = line.split(/\s+/).slice(1)
  const path: string[] = []
  let command = program
  let index = 0
  while (index < words.length) {
    const child = command.commands.find(candidate => candidate.name() === words[index])
    if (child === undefined) break
    command = child
    path.push(words[index]!)
    index += 1
  }
  if (path.length === 0 || command.commands.length > 0 && index === words.length) {
    throw new Error(`Unknown or incomplete command: ${line}`)
  }

  const options: Option[] = []
  for (let current: Command | null = command; current !== null; current = current.parent) {
    options.push(...current.options)
  }
  const seen = new Set<Option>()
  const positionals: string[] = []
  for (; index < words.length; index += 1) {
    const token = words[index]!
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    const flag = token.split('=', 1)[0]!
    const option = options.find(candidate => candidate.long === flag || candidate.short === flag)
    if (option === undefined) throw new Error(`Unknown flag ${flag}: ${line}`)
    seen.add(option)
    if (!token.includes('=') && (option.required || option.optional)) {
      index += 1
      if (words[index] === undefined) throw new Error(`Missing value for ${flag}: ${line}`)
    }
  }

  const requiredArguments = command.registeredArguments.filter(argument => argument.required)
  if (positionals.length < requiredArguments.length || positionals.length > command.registeredArguments.length) {
    throw new Error(`Invalid positional arguments: ${line}`)
  }
  const missingOption = command.options.find(option => option.mandatory && !seen.has(option))
  if (missingOption !== undefined) throw new Error(`Missing ${missingOption.long}: ${line}`)

  if (path.join(' ') === 'operations schema' && !positionals[0]?.startsWith('<')) {
    getHisOperation(positionals[0] ?? '')
  }
  const operationIdIndex = words.indexOf('--operation-id')
  const operationId = operationIdIndex === -1 ? undefined : words[operationIdIndex + 1]
  if (operationId !== undefined && !operationId.startsWith('<')) {
    const receiptTarget = getHisOperation(operationId)
    if (receiptTarget.requirements.idempotency !== 'required') {
      throw new Error(`Operation does not create a Command receipt: ${operationId}`)
    }
  }
  return {
    commandPath: path.join(' '),
    operation: listHisOperations().find(operation => operation.cliPath.join(' ') === path.join(' ')),
  }
}

it('住院命令与岗位、版本、幂等及技能示例同步', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  const examples = commandLines(skill)
  expect(getHisOperation('inpatient.admission.register').version).toBe(3)
  expect(getHisOperation('inpatient.admission.register').input.safeParse({ patientId: 'synthetic', patientVersion: '1', admissionRoute: 'direct', wardId: 'ward-general', depositFen: 0 }).success).toBe(false)
  expect(skill).toContain('expectedEpoch')
  const admissionExample = /```json\n([\s\S]+?)\n```/.exec(skill)
  expect(admissionExample).not.toBeNull()
  expect(getHisOperation('inpatient.admission.register').input.parse(JSON.parse(admissionExample![1]!)))
    .toMatchObject({ expectedEpoch: 'epoch-1', wardId: 'ward-general', depositFen: 100000 })
  const diagnosisExample=[...skill.matchAll(/```json\n([\s\S]+?)\n```/g)][1]
  expect(diagnosisExample).toBeDefined()
  expect(getHisOperation('inpatient.diagnosis.confirm').input.parse(JSON.parse(diagnosisExample![1]!))).toMatchObject({entries:[{role:'primary',admissionCondition:'1'}]})
  const referenceSkill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
  for (const kind of ['diagnoses', 'medications', 'laboratory']) {
    const operation = getHisOperation(`reference.${kind}.search`)
    expect(operation.roles).toContain('inpatient-doctor')
    expect(operation.version).toBe(2)
    expect(referenceSkill).toContain(operation.id)
    const line = commandLines(referenceSkill).find(line => line.startsWith(`clinmesh reference ${kind} search `))!
    expect(inspectExample(program, line).operation?.id).toBe(operation.id)
  }
  for (const operation of listHisOperations().filter(operation => operation.id.startsWith('inpatient.'))) {
    const prefix = `clinmesh ${operation.cliPath.join(' ')}`
    const line = examples.find(line => line === prefix || line.startsWith(`${prefix} `))!
    expect(line).toBeDefined()
    expect(inspectExample(program, line).operation?.id).toBe(operation.id)
    expect(operation.handlerOwner).toBe('InpatientService')
    expect(operation.skill).toBe('clinmesh-inpatient')
    if (operation.mode === 'command') expect(operation.requirements).toEqual({
      expectedVersions: !operation.id.startsWith('inpatient.financial.insurance.'), idempotency: 'required',
    })
  }
})

describe('ClinMesh CLI Agent Skills', () => {
  it('keeps document quality examples narrow and separate from clinical draft writes', async () => {
    const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    for (const action of ['get', 'check', 'retain']) {
      const operation = getHisOperation(`doctor.document-quality.${action}`)
      const line = commandLines(skill).find(line => line.startsWith(`clinmesh doctor document-quality ${action}`))!
      expect(line).toBeDefined()
      expect(inspectExample(program, line).operation?.id).toBe(operation.id)
      expect(operation.skill).toBe('clinmesh-doctor')
    }
    const check = getHisOperation('doctor.document-quality.check')
    const context = { caseId: 'synthetic-case', encounterId: 'synthetic-encounter', encounterVersion: '3' }
    expect(check.input.safeParse({ ...context, expectedDraftVersion: 0 }).success).toBe(true)
    expect(check.input.safeParse({ ...context, expectedDraftVersion: 0, clientId: 'editor-1' }).success).toBe(false)
    expect(check.input.safeParse({ ...context, expectedDraftVersion: 0, url: 'https://example.invalid' }).success).toBe(false)
    const retain = getHisOperation('doctor.document-quality.retain')
    expect(retain.input.safeParse({ ...context, issueId: 'synthetic-issue', expectedInputFingerprint: 'a'.repeat(64) }).success).toBe(true)
    expect(retain.input.safeParse({ ...context, issueId: 'synthetic-issue' }).success).toBe(false)
    expect(skill).toContain('does not save the clinical draft')
    expect(skill).toContain('explicit clinician decision')
    expect(skill).toContain('does not add a signing gate')
    const get = getHisOperation('doctor.document-quality.get')
    const failed = { caseId: 'synthetic-case', encounterId: 'synthetic-encounter', draftVersion: 1, generation: 1,
      inputFingerprint: 'a'.repeat(64), documentFingerprint: 'b'.repeat(64), status: 'failed', stale: false,
      issues: [], notices: [], errorCode: 'AI_RESPONSE_INVALID', failure: { stage: 'generation', reason: 'invalid-source' } }
    expect(get.output.safeParse(failed).success).toBe(true)
    expect(get.output.safeParse({ ...failed, failure: { ...failed.failure, rawContent: 'private model text' } }).success).toBe(false)
    expect(skill).toContain('failure.stage')
    expect(skill).toContain('refresh: true')
  })
  it('keeps document examples aligned with optional family and allergy history', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
    const document = { assessment: '继续评估。', chiefComplaint: '头晕一周。', disposition: '门诊随访。',
      followUp: '加重时就诊。', historyOfPresentIllness: '站立时头晕。', physicalExamination: '神志清楚。' }
    for (const [prefix, version, input] of [
      ['clinmesh encounter clinical-document draft set', 5, { encounterId: 'synthetic', encounterVersion: '1', expectedDraftVersion: 0 }],
      ['clinmesh clinical-document revise', 2, { compositionId: 'synthetic', compositionVersion: '1', encounterId: 'synthetic', encounterVersion: '1', reason: '补充病史。' }],
    ] as const) {
      const line = commandLines(skill).find(line => line.startsWith(prefix))!
      const operation = inspectExample(program, line).operation!
      expect(operation.version).toBe(version)
      expect(operation.input.safeParse({ ...input, document }).success).toBe(true)
      expect(operation.input.safeParse({ ...input, document: { ...document, familyHistory: '', allergyHistory: '' } }).success).toBe(true)
      expect(operation.input.safeParse({ ...input, document: { ...document, familyHistory: '史'.repeat(4001) } }).success).toBe(false)
      expect(operation.summary).toContain('familyHistory')
    }
    expect(skill).toContain('`familyHistory`')
    expect(skill).toContain('`allergyHistory`')
    expect(skill).toContain('不创建正式 AllergyIntolerance')
  })
  it('keeps recording controls narrow, versioned and bound to the doctor skill', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    const operation = getHisOperation('encounter.consultation-recording.control')
    const line = commandLines(skill).find(line => line.startsWith('clinmesh encounter consultation-recording control'))!
    expect(inspectExample(createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } }), line).operation?.id).toBe(operation.id)
    for (const action of ['activate', 'pause', 'resume', 'backfill', 'retry']) {
      expect(operation.input.safeParse({ encounterId: 'synthetic-encounter', encounterVersion: '3', expectedRecordingVersion: 1, action }).success).toBe(true)
    }
    expect(operation.input.safeParse({ encounterId: 'synthetic-encounter', encounterVersion: '3', action: 'resume', document: {} }).success).toBe(false)
    expect(skill).toContain('processedCount')
    expect(skill).toContain('explicitly starts it')
    expect(operation.version).toBe(6)
    expect(operation.summary).toContain('backfill requires an existing Consultation')
    expect(operation.summary).toContain('WORKFLOW_CONFLICT')
    expect(operation.summary).toContain('retired semantic checks cannot be retried')
    expect(operation.summary).toContain('MODEL_OUTCOME_UNKNOWN')
    expect(skill).toContain('`MODEL_OUTCOME_UNKNOWN` stops automatic resending')
    const read = getHisOperation('doctor.case.get')
    expect(read.version).toBe(15)
    expect(read.summary).toContain('sourceResults')
    expect(read.summary).toContain('legacy verification counts are zero and issues empty')
    expect(skill).toContain('Retry actual recording failures')
    expect(skill).toContain('existing `qualityControl`')
    expect(skill).toContain('Backfill requires an existing Consultation')
    expect(skill).toContain('WORKFLOW_CONFLICT')
  })
  it('does not expose removed history review commands or signing acknowledgement', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    expect(skill).not.toContain('clinmesh encounter consultation-history review')
    expect(skill).toContain('recorded directly')
    expect(() => getHisOperation('encounter.consultation-history.review')).toThrow()
    const sign = getHisOperation('encounter.clinical-document.sign')
    expect(sign.input.safeParse({ encounterId: 'synthetic-encounter', encounterVersion: '1', commitToken: 'synthetic-sign-commit-token', previewId: 'synthetic-preview', consultationReviewed: true }).success).toBe(false)
  })
  it('keeps the doctor draft example compatible with incomplete content and the versioned Catalog', async () => {
    const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md'), 'utf8')
    const operation = getHisOperation('encounter.clinical-document.draft.set')
    expect(operation.version).toBe(5)
    expect(skill).toContain('empty fields')
    expect(skill).toContain('including whitespace and punctuation')
    expect(operation.summary).toContain('whitespace is preserved exactly')
    expect(skill).toContain('consultationRecording')
    expect(skill).toContain('hasSavedDraft')
    expect(getHisOperation('doctor.case.get').summary).toContain('hasSavedDraft')
    expect(skill).toContain('consultationRecording.failures')
    expect(getHisOperation('doctor.case.get').summary).toContain('failures')
    const line = commandLines(skill).find(line => line.startsWith('clinmesh encounter clinical-document draft set'))!
    expect(inspectExample(createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } }), line).operation?.id).toBe(operation.id)
    const parsed = operation.input.parse({ encounterId: 'synthetic-encounter', encounterVersion: '3', expectedDraftVersion: 0,
      document: { chiefComplaint: ' 头晕一周 ', historyOfPresentIllness: '', physicalExamination: '',
        assessment: '', disposition: '', followUp: '' },
    })
    expect(parsed).toMatchObject({ document: { chiefComplaint: ' 头晕一周 ' } })
  })
  it('documents missing visit numbers and triage in the versioned doctor read contracts', async () => {
    const doctorSkill = await readFile(resolve(
      import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md',
    ), 'utf8')
    for (const id of ['doctor.queue.list', 'doctor.case.get']) {
      const operation = getHisOperation(id)
      expect(operation.version).toBe(id === 'doctor.case.get' ? 15 : 3)
      expect(operation.summary).toContain('presentation')
      expect(operation.summary).toContain('registrationNumber')
      const line = commandLines(doctorSkill).find(line => line.startsWith(id === 'doctor.case.get' ? 'clinmesh doctor case get ' : 'clinmesh doctor queue list'))!
      expect(inspectExample(createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } }), line).operation?.id).toBe(id)
      for (const registrationNumber of ['CM-OP-20261020-1234567', 'CM-OP-20260824-0042', null]) {
        const parsed = operation.output.safeParse(id === 'doctor.queue.list' ? { items: [{ registrationNumber }] } : { registrationNumber })
        expect(parsed.success).toBe(false)
        if (!parsed.success) expect(parsed.error.issues.some(issue => issue.path.includes('registrationNumber'))).toBe(false)
      }
      const result = operation.output.safeParse(id === 'doctor.queue.list'
        ? { items: [{ presentation: null }] }
        : { presentation: null })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(issue => issue.path.includes('presentation'))).toBe(false)
      }
      const invalid = operation.output.safeParse(id === 'doctor.queue.list'
        ? { items: [{ presentation: 'unknown' }] }
        : { presentation: 'unknown' })
      expect(invalid.success).toBe(false)
      if (!invalid.success) {
        expect(invalid.error.issues.some(issue => issue.path.includes('presentation'))).toBe(true)
      }
    }
    expect(doctorSkill).toContain('presentation: null')
    expect(doctorSkill).toContain('`registrationNumber`')
    expect(doctorSkill).toContain('`patient.identifier`')
  })

  it('keeps correlation recovery guidance aligned with the Catalog error schema', async () => {
    const sharedSkill = await readFile(resolve(
      import.meta.dirname,
      '../../../skills/clinmesh-shared/SKILL.md',
    ), 'utf8')
    const error = getHisOperation('patient.create').error.parse({
      code: 'ambiguous_outcome',
      correlationId: '01991234-7abc-7def-8abc-0123456789ab',
      message: 'Inspect the Command receipt before retrying',
      operationId: 'patient.create',
      outcome: 'ambiguous',
      retryable: false,
      type: 'api',
    })

    expect(sharedSkill).toContain('error.correlationId')
    expect(error.correlationId).toBe('01991234-7abc-7def-8abc-0123456789ab')
  })

  it('documents non-retryable laboratory evidence errors on both order operations', async () => {
    const doctorSkill = await readFile(resolve(
      import.meta.dirname, '../../../skills/clinmesh-doctor/SKILL.md',
    ), 'utf8')
    for (const id of ['encounter.laboratory-request.draft.set', 'encounter.laboratory-request.issue']) {
      const operation = getHisOperation(id)
      expect(operation.summary).toContain('LABORATORY_GENERATION_UNSUPPORTED')
      expect(operation.error.parse({
        code: 'LABORATORY_GENERATION_UNSUPPORTED', message: '缺少结果底账',
        operationId: id, outcome: 'definitely_not_sent', retryable: false, type: 'conflict',
      }).retryable).toBe(false)
    }
    expect(doctorSkill).toContain('LABORATORY_GENERATION_UNSUPPORTED')
    expect(doctorSkill).toContain('INVESTIGATION_UNSUPPORTED')
    expect(doctorSkill).toContain('AI_REQUEST_FAILED')
  })

  it('keeps every documented clinical command on a real Catalog path', async () => {
    const skillsRoot = resolve(import.meta.dirname, '../../../skills')
    const skillNames = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('clinmesh-'))
      .map(entry => entry.name)
      .toSorted()
    expect(skillNames).toEqual(expectedSkills)

    const sharedPaths = ['auth login', 'auth logout', 'auth role use', 'auth status', 'context show', 'operations list', 'operations schema']
    const program = createCliProgram({
      stderr: { write: () => undefined },
      stdout: { write: () => undefined },
    })
    for (const skillName of skillNames) {
      const markdown = await readFile(resolve(skillsRoot, skillName, 'SKILL.md'), 'utf8')
      const commands = commandLines(markdown)
      if (skillName === 'clinmesh-doctor') {
        expect(commands).toContain('clinmesh doctor queue list --view waiting')
        expect(commands).toContain('clinmesh doctor queue list --view active')
      }
      expect(commands.length, `${skillName} has no executable examples`).toBeGreaterThan(0)
      if (skillName === 'clinmesh-registration') {
        expect(commands).toContain(
          'clinmesh registration synthetic-case list --search <name-or-mrn>',
        )
      }
      expect(commands.some(command => command.includes('agent client') || command.includes('agent grant'))).toBe(false)
      for (const line of commands) {
        const { commandPath, operation } = inspectExample(program, line)
        const matchesShared = sharedPaths.includes(commandPath)
        expect(operation !== undefined || matchesShared, `${skillName}: ${line}`).toBe(true)
        if (operation !== undefined && operation.id !== 'command.receipt.get') {
          expect(operation.skill, `${skillName}: ${operation.id}`).toBe(skillName)
        }
      }
    }
    expect(() => inspectExample(program, 'clinmesh patient search --bogus value'))
      .toThrow('Unknown flag --bogus')
    expect(() => inspectExample(
      program,
      'clinmesh command receipt get --operation-id missing.operation --idempotency-key example-key',
    )).toThrow('Unknown HIS operation: missing.operation')
    expect(() => inspectExample(
      program,
      'clinmesh command receipt get --operation-id patient.search --idempotency-key example-key',
    )).toThrow('Operation does not create a Command receipt: patient.search')
  })
})

it('手术CLI与Skill保留双准备、实际实施与原receipt恢复合同', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [path, id, role] of [
    ['request-surgery','request','inpatient-doctor'], ['check-surgery-preop','check-preop','ward-nurse'],
    ['confirm-surgery-consent','confirm-consent','inpatient-doctor'], ['execute-surgery','execute','inpatient-doctor'], ['cancel-surgery','cancel','inpatient-doctor'],
  ] as const) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path} `))!
    const operation = inspectExample(program, line).operation!
    expect(operation.id).toBe(`inpatient.surgery.${id}`)
    expect(operation.roles).toEqual([role])
    expect(operation.requirements).toEqual({ expectedVersions: true, idempotency: 'required' })
  }
  const executionExample = [...skill.matchAll(/```json\n([\s\S]+?)\n```/g)][2]
  expect(executionExample).toBeDefined()
  expect(getHisOperation('inpatient.surgery.execute').input.parse(JSON.parse(executionExample![1]!))).toMatchObject({ expectedRequestVersion: 3, materials: [{ quantity: 2 }] })
  expect(getHisOperation('inpatient.order.issue').version).toBe(4)
  expect(skill).toContain('surgeryExecutionId')
  expect(skill).toContain('inpatient.surgery.execute')
  expect(getHisOperation('inpatient.surgery.catalog').version).toBe(2)
  expect(getHisOperation('inpatient.surgery.catalog').summary).toContain('unit-unconfirmed')
  expect(skill).toContain('unavailableReason=unit-unconfirmed')
  expect(skill).toContain('baseSupplyPriceFen')
})

it('keeps inpatient investigation and transfer examples bound to narrow versioned commands', async () => {
  const skill=await readFile(resolve(import.meta.dirname,'../../../skills/clinmesh-inpatient/SKILL.md'),'utf8')
  const examples=[...skill.matchAll(/```json\n([\s\S]+?)\n```/g)].map(match=>JSON.parse(match[1]!))
  const investigation=examples.find(input=>input.selection?.kind==='imaging')
  expect(getHisOperation('inpatient.investigation.issue').input.parse(investigation)).toMatchObject({catalogVersion:1,selection:{kind:'imaging'}})
  expect(getHisOperation('inpatient.investigation.issue').input.safeParse({...investigation,amountFen:1}).success).toBe(false)
  expect(getHisOperation('inpatient.investigation.issue').input.safeParse({...investigation,url:'https://example.invalid'}).success).toBe(false)
  expect(getHisOperation('inpatient.transfer.receive').roles).toEqual(['ward-nurse'])
  expect(getHisOperation('inpatient.transfer.receive').input.safeParse({admissionId:'synthetic-admission',encounterVersion:'2',transferId:'synthetic-transfer',expectedTransferVersion:2,bedId:'bed-surgery-1',organizationId:'untrusted'}).success).toBe(false)
  expect(skill).toContain('unavailableReason=unpriced')
})

it('住院出院与结算示例使用冻结指纹、原输入与窄岗位合同', async () => {
  const program = createCliProgram({ stdout: { write: () => undefined }, stderr: { write: () => undefined } })
  const skill = await readFile(resolve(import.meta.dirname, '../../../skills/clinmesh-inpatient/SKILL.md'), 'utf8')
  for (const [path, id, role] of [['issue-discharge','issue','inpatient-doctor'],['depart','depart','ward-nurse'],['recall','recall','inpatient-doctor'],['clear-bed','clear','ward-nurse'],['settle','settle','cashier']] as const) {
    const line = commandLines(skill).find(line => line.startsWith(`clinmesh inpatient ${path} `))!
    expect(inspectExample(program,line).operation?.id).toBe(`inpatient.discharge.${id}`)
    expect(getHisOperation(`inpatient.discharge.${id}`).roles).toEqual([role])
  }
  const example = skill.match(/`settlement.json`[^]*?```json\n([^]*?)\n```/)
  expect(example).not.toBeNull()
  expect(getHisOperation('inpatient.discharge.settle').input.parse(JSON.parse(example![1]!))).toMatchObject({ expectedChargesFen:5000, expectedBalanceFen:-95000 })
  expect(getHisOperation('inpatient.discharge.preview').roles).toEqual(['cashier'])
  expect(getHisOperation('inpatient.discharge.read').roles).not.toContain('cashier')
  expect(getHisOperation('inpatient.discharge.settle').input.safeParse({ admissionId:'synthetic',encounterVersion:'4',expectedChargesFen:5000,expectedBalanceFen:-95000 }).success).toBe(false)
  expect(skill).toContain('INPATIENT_SETTLEMENT_PREVIEW_STALE')
  expect(skill).toContain('inpatient.discharge.settle')
})

it('病案示例绑定原修订与来源指纹、显式主操作及独立审核岗位', async () => {
  const program=createCliProgram({stdout:{write:()=>undefined},stderr:{write:()=>undefined}})
  const skill=await readFile(resolve(import.meta.dirname,'../../../skills/clinmesh-inpatient/SKILL.md'),'utf8')
  for(const [path,id,role] of [['submit-record','submit','inpatient-doctor'],['review-record','review','medical-records'],['archive-record','archive','medical-records']] as const) {
    const line=commandLines(skill).find(line=>line.startsWith(`clinmesh inpatient ${path} `))!
    expect(inspectExample(program,line).operation?.id).toBe(`inpatient.record.${id}`)
    expect(getHisOperation(`inpatient.record.${id}`).roles).toEqual([role])
    const match=skill.match(new RegExp('`record-'+id+'.json`[^]*?```json\\n([^]*?)\\n```'))!
    expect(getHisOperation(`inpatient.record.${id}`).input.parse(JSON.parse(match[1]!))).toMatchObject({expectedSourcesHash:'a'.repeat(64)})
  }
  expect(getHisOperation('inpatient.record.submit').input.safeParse({admissionId:'synthetic',expectedRevision:0,expectedSourcesHash:'a'.repeat(64)}).success).toBe(false)
  expect(getHisOperation('inpatient.record.review').input.safeParse({admissionId:'synthetic',expectedRevision:1,expectedSourcesHash:'a'.repeat(64),outcome:'returned'}).success).toBe(false)
  expect(skill).toContain('INPATIENT_RECORD_STALE')
})
