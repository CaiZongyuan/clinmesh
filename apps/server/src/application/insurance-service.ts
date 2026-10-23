import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { insuranceBalanceSchema, insuranceCancelInputSchema, insuranceConfirmInputSchema, insurancePlans, insurancePreviewInputSchema, insurancePreviewSchema, insuranceResponseSchema, insuranceSettlementSchema, insuranceSourceSchema, insuranceStateSchema, type InsuranceSource, type InsuranceTarget } from '@clinmesh/contracts/insurance'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandEffect, CommandExecutor, CommandTransaction } from './command-executor.ts'
import { WorkspaceRepository } from '../infrastructure/sqlite/workspace-repository.ts'
export type { InsuranceSource, InsuranceTarget } from '@clinmesh/contracts/insurance'

export class InsuranceError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 409) { super(message) }
}
export interface InsuranceOptions {
  readSource: (context: ActorContext, target: InsuranceTarget) => InsuranceSource
  assertChangeAllowed?: (context: ActorContext, source: InsuranceSource, action: 'settle' | 'cancel') => void
  onAllocationChanged?: (context: ActorContext, source: InsuranceSource, transaction: CommandTransaction, effects: CommandEffect[]) => void
  now?: () => Date
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Settlement = z.infer<typeof insuranceSettlementSchema>
function activeFromHistory(history: Settlement[]) {
  const reversed = new Set(history.flatMap(row => row.reversesId === undefined ? [] : [row.reversesId]))
  return history.filter(row => row.reversesId === undefined && !reversed.has(row.id))
}
export class InsuranceService {
  constructor(readonly database: ClinMeshDatabase, readonly commands: CommandExecutor, readonly options: InsuranceOptions) {}
  #authorize(context: ActorContext) {
    if (context.roleCode !== 'cashier') throw new InsuranceError('INSURANCE_ROLE_FORBIDDEN', '仅收费员可办理患者医保', 403)
    new WorkspaceRepository(this.database).assertCurrent(context, context.scenarioRunId)
  }
  #year(context: ActorContext) {
    const row = z.object({ virtual_time: z.string() }).parse(this.database.driver.prepare('SELECT virtual_time FROM scenario_epoch_state WHERE workspace_id=? AND epoch=?').get(context.workspaceId, context.epoch))
    return new Intl.DateTimeFormat('en', {timeZone:'Asia/Shanghai',year:'numeric'}).format(new Date(row.virtual_time))
  }
  #actor(context: ActorContext) { return hash([context.actorId, context.practitionerRoleId, context.workspaceId, context.epoch, context.scenarioRunId]) }
  #history(context: ActorContext, target: InsuranceTarget) {
    return z.array(z.object({ data_json: z.string() })).parse(this.database.driver.prepare('SELECT data_json FROM insurance_event WHERE workspace_id=? AND epoch=? AND target_kind=? AND target_id=? ORDER BY rowid').all(context.workspaceId, context.epoch, target.kind, target.id)).map(row => insuranceSettlementSchema.parse(JSON.parse(row.data_json)))
  }
  balance(context: ActorContext, patientId: string, year = this.#year(context)) {
    const rows = z.array(z.object({ plan_code: z.enum(['employee-v1','resident-v1']), target_kind: z.enum(['outpatient','inpatient']), eligible_delta: z.number().int(), fund_delta: z.number().int(), account_delta: z.number().int() })).parse(this.database.driver.prepare('SELECT * FROM insurance_event WHERE workspace_id=? AND epoch=? AND patient_id=? AND year=? ORDER BY rowid').all(context.workspaceId, context.epoch, patientId, year))
    const planCode = rows[0]?.plan_code
    const total = (field: 'eligible_delta' | 'fund_delta' | 'account_delta', kind?: InsuranceTarget['kind']) => rows.reduce((sum,row) => sum + (kind === undefined || row.target_kind === kind ? row[field] : 0), 0)
    return insuranceBalanceSchema.parse({ patientId, year, version: rows.length, ...(planCode === undefined ? {} : {planCode}), accountFen: (planCode === undefined ? 0 : insurancePlans[planCode].initialAccountFen) + total('account_delta'), eligibleFen: total('eligible_delta'), fundFen: total('fund_delta'), outpatientEligibleFen: total('eligible_delta','outpatient'), outpatientFundFen: total('fund_delta','outpatient'), inpatientEligibleFen: total('eligible_delta','inpatient'), inpatientFundFen: total('fund_delta','inpatient') })
  }
  activeSettlements(context: ActorContext, target: InsuranceTarget) {
    return activeFromHistory(this.#history(context, target))
  }
  hadCompensation(context: ActorContext, reference: string) {
    const rows=z.array(z.object({data_json:z.string()})).parse(this.database.driver.prepare('SELECT data_json FROM insurance_event WHERE workspace_id=? AND epoch=? AND reverses_id IS NOT NULL').all(context.workspaceId,context.epoch))
    return rows.some(row=>insuranceSettlementSchema.parse(JSON.parse(row.data_json)).allocations.some(item=>item.reference===reference))
  }
  validAllocation(context: ActorContext, target: InsuranceTarget) {
    return this.activeSettlements(context, target).at(-1)
  }
  coverage(context: ActorContext, reference: string) {
    const rows = z.array(z.object({data_json:z.string()})).parse(this.database.driver.prepare('SELECT data_json FROM insurance_event e WHERE workspace_id=? AND epoch=? AND reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM insurance_event r WHERE r.workspace_id=e.workspace_id AND r.epoch=e.epoch AND r.reverses_id=e.event_id)').all(context.workspaceId,context.epoch))
    return rows.reduce((sum,row) => sum + insuranceSettlementSchema.parse(JSON.parse(row.data_json)).allocations.filter(a=>a.reference===reference).reduce((subtotal,a)=>subtotal+a.fundFen+a.accountFen,0),0)
  }
  state(context: ActorContext, target: InsuranceTarget) {
    // Commands already own their transaction and audit for the returned projection.
    if (this.database.driver.inTransaction) return this.#state(context, target)
    let result: z.infer<typeof insuranceStateSchema>
    try {
      result = this.#state(context, target)
    } catch (error) {
      try { this.commands.auditRead(context, 'insurance.get', target, 'failed') }
      catch { /* Keep the original rejection when audit storage is unavailable. */ }
      throw error
    }
    this.commands.auditRead(context, 'insurance.get', target, 'success')
    return result
  }
  #state(context: ActorContext, target: InsuranceTarget) {
    this.#authorize(context)
    const source = insuranceSourceSchema.parse(this.options.readSource(context, target))
    const history = this.#history(context, target), activeSettlements = activeFromHistory(history), active = activeSettlements.at(-1)
    const balance = this.balance(context, source.patientId)
    const years = [...new Set([...history.map(row => row.year), balance.year])].sort()
    const annualBalances = years.map(year => year === balance.year ? balance : this.balance(context, source.patientId, year))
    return insuranceStateSchema.parse({ target, balance, annualBalances, history, activeSettlements, ...(active === undefined ? {} : { active }) })
  }
  preview(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input=insurancePreviewInputSchema.parse(raw)
    return this.commands.execute({ context,input,idempotencyKey,operation:'insurance.preview',expectedVersions:{},dataSchema:insurancePreviewSchema,authorize:()=>this.#authorize(context) }, () => {
      const source=insuranceSourceSchema.parse(this.options.readSource(context,input.target)), balance=this.balance(context,source.patientId)
      if(source.charges.length===0)throw new InsuranceError('INSURANCE_NO_CHARGES','当前没有可结算费用')
      if(this.activeSettlements(context,input.target).some(row=>row.allocations.some(item=>source.charges.some(charge=>charge.reference===item.reference))))throw new InsuranceError('INSURANCE_ALREADY_SETTLED','请先撤销原待遇后重新结算')
      if(balance.planCode!==undefined&&balance.planCode!==input.planCode)throw new InsuranceError('INSURANCE_PLAN_CONFLICT','本年度已固定合成方案，不可切换待遇账户')
      this.options.assertChangeAllowed?.(context,source,'settle')
      const data=this.previewForSource(context,source,input.planCode,balance.year)
      return {data,effects:[{kind:'created' as const,reference:`InsurancePreview/${data.previewId}`,versionId:'1'}]}
    })
  }
  /** Trusted callers compose this primitive inside their authorized Command transaction. */
  previewForSource(context:ActorContext,source:InsuranceSource,planCode:Settlement['planCode'],year:string) {
    if(!this.database.driver.inTransaction)throw new InsuranceError('INSURANCE_TRANSACTION_REQUIRED','待遇预览必须处于 Command 事务')
    const balance=this.balance(context,source.patientId,year)
    if(balance.planCode!==undefined&&balance.planCode!==planCode)throw new InsuranceError('INSURANCE_PLAN_CONFLICT','原年度合成方案不可切换')
      const plan=insurancePlans[planCode], parameters=plan[source.target.kind]
      let deductible=Math.max(0,parameters.deductibleFen-(source.target.kind==='outpatient'?balance.outpatientEligibleFen:balance.inpatientEligibleFen))
      let cap=Math.max(0,parameters.capFen-(source.target.kind==='outpatient'?balance.outpatientFundFen:balance.inpatientFundFen))
      let account=balance.planCode===undefined?plan.initialAccountFen:balance.accountFen
      const allocations=source.charges.map(charge=>{
        const outsideFen=charge.coverage.included?0:charge.amountFen
        const priorSelfPayFen=charge.coverage.included?Number(BigInt(charge.amountFen)*BigInt(charge.coverage.priorSelfPayBps)/10000n):0
        const eligibleFen=charge.amountFen-outsideFen-priorSelfPayFen, deductibleFen=Math.min(eligibleFen,deductible)
        deductible-=deductibleFen
        const fundFen=Math.min(cap,Number(BigInt(eligibleFen-deductibleFen)*BigInt(parameters.ratioBps)/10000n));cap-=fundFen
        // 目录外费用由患者承担，个人账户仅抵扣目录内个人负担。
        const accountFen=Math.min(account,charge.amountFen-outsideFen-fundFen);account-=accountFen
        return {reference:charge.reference,amountFen:charge.amountFen,outsideFen,priorSelfPayFen,eligibleFen,deductibleFen,fundFen,accountFen,patientFen:charge.amountFen-fundFen-accountFen}
      })
      const sum=(field:'amountFen'|'fundFen'|'accountFen'|'patientFen'|'eligibleFen'|'deductibleFen')=>allocations.reduce((value,row)=>value+row[field],0)
      const previewId=randomUUID(),commitToken=randomUUID()+randomUUID(),now=this.options.now?.()??new Date()
      const settlement=insuranceSettlementSchema.parse({id:randomUUID(),target:source.target,planCode:planCode,year:balance.year,source,sourceFingerprint:hash(source),allocations,totalFen:sum('amountFen'),fundFen:sum('fundFen'),accountFen:sum('accountFen'),patientFen:sum('patientFen'),eligibleFen:sum('eligibleFen'),deductibleFen:sum('deductibleFen'),balanceVersion:balance.version,createdAt:now.toISOString()})
      const data={previewId,commitToken,expiresAt:new Date(now.getTime()+300000).toISOString(),settlement,balance}
      this.database.driver.prepare('INSERT INTO insurance_preview VALUES(?,?,?,?,?,?,?)').run(context.workspaceId,context.epoch,previewId,this.#actor(context),hash(commitToken),data.expiresAt,JSON.stringify(data))
    return insurancePreviewSchema.parse(data)
  }
  reviewedPreview(context:ActorContext,previewId:string,commitToken:string) {
    const row=z.object({actor_hash:z.string(),token_hash:z.string(),expires_at:z.string(),data_json:z.string()}).optional().parse(this.database.driver.prepare('SELECT * FROM insurance_preview WHERE workspace_id=? AND epoch=? AND preview_id=?').get(context.workspaceId,context.epoch,previewId))
    if(row===undefined||row.actor_hash!==this.#actor(context)||row.token_hash!==hash(commitToken)||Date.parse(row.expires_at)<=(this.options.now?.()??new Date()).getTime())throw new InsuranceError('INSURANCE_PREVIEW_INVALID','预览已失效，请重新预览并审阅')
    return insurancePreviewSchema.parse(JSON.parse(row.data_json))
  }
  recordSettlement(context:ActorContext,settlement:Settlement,effects:CommandEffect[]) {
    if(!this.database.driver.inTransaction)throw new InsuranceError('INSURANCE_TRANSACTION_REQUIRED','待遇确认必须处于 Command 事务')
    this.#append(context,settlement,1,effects)
  }

  #append(context:ActorContext,settlement:Settlement,sign:1|-1,effects:CommandEffect[]) {
    this.database.driver.prepare('INSERT INTO insurance_event VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(context.workspaceId,context.epoch,settlement.id,settlement.source.patientId,settlement.year,settlement.planCode,settlement.target.kind,settlement.target.id,sign*settlement.eligibleFen,sign*settlement.fundFen,-sign*settlement.accountFen,settlement.reversesId??null,JSON.stringify(settlement))
    effects.push({kind:'created',reference:`InsuranceSettlement/${settlement.id}`,versionId:'1'})
  }
  confirm(context:ActorContext,raw:unknown,idempotencyKey:string) {
    const input=insuranceConfirmInputSchema.parse(raw)
    return this.commands.execute({context,input,idempotencyKey,operation:'insurance.confirm',expectedVersions:{},dataSchema:insuranceResponseSchema.shape.data,authorize:()=>this.#authorize(context)},transaction=>{
      const preview=this.reviewedPreview(context,input.previewId,input.commitToken),settlement=preview.settlement
      const source=insuranceSourceSchema.parse(this.options.readSource(context,input.target)),balance=this.balance(context,source.patientId)
      if(hash(input.target)!==hash(settlement.target)||hash(source)!==settlement.sourceFingerprint||balance.year!==settlement.year||balance.version!==settlement.balanceVersion||this.activeSettlements(context,input.target).some(row=>row.allocations.some(item=>source.charges.some(charge=>charge.reference===item.reference))))throw new InsuranceError('INSURANCE_PREVIEW_STALE','费用或患者年度余额已变化，请重新预览')
      this.options.assertChangeAllowed?.(context,source,'settle')
      const effects:CommandEffect[]=[];this.#append(context,settlement,1,effects)
      this.options.onAllocationChanged?.(context,source,transaction,effects)
      return {data:this.state(context,input.target),effects}
    })
  }
  /** 调用方持有授权财务更正 Command 事务；只追加原影响的逆向事件。 */
  compensate(context:ActorContext,settlementId:string,effects:CommandEffect[]) {
    if(!this.database.driver.inTransaction)throw new InsuranceError('INSURANCE_TRANSACTION_REQUIRED','待遇补偿必须处于财务 Command 事务')
    const row=z.object({data_json:z.string()}).optional().parse(this.database.driver.prepare('SELECT data_json FROM insurance_event WHERE workspace_id=? AND epoch=? AND event_id=? AND reverses_id IS NULL').get(context.workspaceId,context.epoch,settlementId))
    if(row===undefined)throw new InsuranceError('INSURANCE_SETTLEMENT_MISSING','原待遇不存在',404)
    const original=insuranceSettlementSchema.parse(JSON.parse(row.data_json))
    const existing=this.#history(context,original.target).find(item=>item.reversesId===settlementId)
    if(existing!==undefined)return existing
    const compensation={...original,id:randomUUID(),reversesId:settlementId,createdAt:(this.options.now?.()??new Date()).toISOString()}
    this.#append(context,compensation,-1,effects)
    return compensation
  }
  cancel(context:ActorContext,raw:unknown,idempotencyKey:string) {
    const input=insuranceCancelInputSchema.parse(raw)
    return this.commands.execute({context,input,idempotencyKey,operation:'insurance.cancel',expectedVersions:{},dataSchema:insuranceResponseSchema.shape.data,authorize:()=>this.#authorize(context)},transaction=>{
      const liveSource=insuranceSourceSchema.parse(this.options.readSource(context,input.target)),active=this.activeSettlements(context,input.target).find(item=>item.id===input.settlementId)
      const source=active?.source??liveSource
      if(active?.id!==input.settlementId||this.balance(context,source.patientId,active.year).version!==input.expectedBalanceVersion)throw new InsuranceError('INSURANCE_BALANCE_CONFLICT','待遇或原年度余额已变化，请刷新后办理撤销')
      this.options.assertChangeAllowed?.(context,source,'cancel')
      const effects:CommandEffect[]=[];this.compensate(context,active.id,effects)
      this.options.onAllocationChanged?.(context,source,transaction,effects)
      return {data:this.state(context,input.target),effects}
    })
  }
}
