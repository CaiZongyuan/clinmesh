import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { inpatientTransferSchema,inpatientTransfersSchema,inpatientTransferRequestInputSchema,inpatientTransferActionInputSchema,inpatientTransferReceiveInputSchema,inpatientIncomingTransfersSchema,inpatientTransferCatalogSchema } from '@clinmesh/contracts/inpatient-transfer'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'

const rowSchema=z.object({transfer_id:z.string(),admission_id:z.string(),source_ward_id:z.string(),source_organization_id:z.string(),target_ward_id:z.string(),target_organization_id:z.string(),reason:z.string(),
  status:inpatientTransferSchema.shape.status,version:z.number().int().positive(),requested_at:z.string(),handed_over_at:z.string().nullable(),received_at:z.string().nullable(),bed_id:z.string().nullable()})
type TransferRow=z.infer<typeof rowSchema>

export class InpatientTransfers {
  constructor(readonly owner:InpatientService) {}
  catalog(context:ActorContext) {
    this.owner.assertRole(context,['inpatient-doctor','ward-nurse'])
    const wards=z.array(z.object({ward_id:z.string(),organization_id:z.string(),name:z.string()})).parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_ward WHERE workspace_id=? AND epoch=? ORDER BY ward_id').all(context.workspaceId,context.epoch))
    const beds=z.array(z.object({bed_id:z.string(),ward_id:z.string(),name:z.string(),occupied:z.number()})).parse(this.owner.database.driver.prepare(`SELECT b.*,EXISTS(SELECT 1 FROM inpatient_bed_occupancy o WHERE o.workspace_id=b.workspace_id AND o.epoch=b.epoch AND o.bed_id=b.bed_id AND o.ended_at IS NULL) occupied
      FROM inpatient_bed b WHERE workspace_id=? AND epoch=? ORDER BY bed_id`).all(context.workspaceId,context.epoch))
    return inpatientTransferCatalogSchema.parse({wards:wards.map(row=>({id:row.ward_id,name:row.name,organizationId:row.organization_id})),beds:beds.map(row=>({id:row.bed_id,wardId:row.ward_id,name:row.name,available:row.occupied===0}))})
  }
  row(context:ActorContext,admissionId:string,transferId:string) {
    const row=rowSchema.optional().parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_transfer WHERE workspace_id=? AND epoch=? AND admission_id=? AND transfer_id=?').get(context.workspaceId,context.epoch,admissionId,transferId))
    if(row===undefined) throw new InpatientError('INPATIENT_TRANSFER_NOT_FOUND','未找到本次住院的转科任务',404)
    return row
  }
  dto(context:ActorContext,row:TransferRow) {
    return inpatientTransferSchema.parse({id:row.transfer_id,admissionId:row.admission_id,sourceWardId:row.source_ward_id,sourceOrganizationId:row.source_organization_id,targetWardId:row.target_ward_id,targetOrganizationId:row.target_organization_id,
      reason:row.reason,status:row.status,version:row.version,taskVersion:this.owner.fhir.read(context,'Task',row.transfer_id).meta!.versionId,requestedAt:row.requested_at,
      ...(row.handed_over_at===null?{}:{handedOverAt:row.handed_over_at}),...(row.received_at===null?{}:{receivedAt:row.received_at}),...(row.bed_id===null?{}:{bedId:row.bed_id})})
  }
  read(context:ActorContext,admissionId:string) {
    this.owner.assertRole(context,['inpatient-doctor','ward-nurse'])
    this.owner.admissionBinding(context,admissionId)
    const rows=z.array(rowSchema).parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_transfer WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY requested_at,transfer_id').all(context.workspaceId,context.epoch,admissionId))
    return inpatientTransfersSchema.parse({admissionId,transfers:rows.map(row=>this.dto(context,row))})
  }
  incoming(context:ActorContext) {
    this.owner.assertRole(context,['ward-nurse'])
    const rows=z.array(rowSchema).parse(this.owner.database.driver.prepare("SELECT * FROM inpatient_transfer WHERE workspace_id=? AND epoch=? AND target_ward_id=? AND target_organization_id=? AND status IN ('requested','handed-over') ORDER BY requested_at,transfer_id").all(context.workspaceId,context.epoch,context.locationId??'',context.organizationId??''))
    return inpatientIncomingTransfersSchema.parse({items:rows.map(row=>{
      const admission=z.object({patient_id:z.string(),inpatient_number:z.string()}).parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId,context.epoch,row.admission_id))
      const patient=this.owner.fhir.read(context,'Patient',admission.patient_id)
      const name=z.array(z.object({text:z.string().optional()})).optional().parse(patient.name)?.[0]?.text??admission.patient_id
      return {admissionId:row.admission_id,patientName:name,inpatientNumber:admission.inpatient_number,encounterVersion:this.owner.fhir.read(context,'Encounter',row.admission_id).meta!.versionId,transfer:this.dto(context,row)}
    })})
  }
  assertNoPending(context:ActorContext,admissionId:string) {
    if(this.owner.database.driver.prepare("SELECT 1 FROM inpatient_transfer WHERE workspace_id=? AND epoch=? AND admission_id=? AND status IN ('requested','handed-over')").get(context.workspaceId,context.epoch,admissionId)) throw new InpatientError('INPATIENT_TRANSFER_PENDING','仍有未接收或未取消的转科任务')
  }
  assertHandoverReady(context:ActorContext,admissionId:string) {
    if(this.owner.database.driver.prepare("SELECT 1 FROM inpatient_order WHERE workspace_id=? AND epoch=? AND admission_id=? AND state NOT IN ('stopped','completed')").get(context.workspaceId,context.epoch,admissionId)) throw new InpatientError('INPATIENT_TRANSFER_ORDERS_PENDING','原科医嘱须停嘱并由护士核停')
    if(this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_execution e JOIN inpatient_order o ON o.workspace_id=e.workspace_id AND o.epoch=e.epoch AND o.order_id=e.order_id
      WHERE o.workspace_id=? AND o.epoch=? AND o.admission_id=? AND e.status NOT IN ('completed','cancelled')`).get(context.workspaceId,context.epoch,admissionId)) throw new InpatientError('INPATIENT_TRANSFER_EXECUTIONS_PENDING','原科未执行任务须明确取消')
    if(this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_investigation i JOIN laboratory_request r ON r.workspace_id=i.workspace_id AND r.epoch=i.epoch AND r.request_id=i.request_id
      WHERE i.workspace_id=? AND i.epoch=? AND i.admission_id=? AND i.sent_at IS NULL AND r.status <> 'cancelled'`).get(context.workspaceId,context.epoch,admissionId)) throw new InpatientError('INPATIENT_TRANSFER_INVESTIGATIONS_PENDING','原科未送检申请须送检或取消')
  }
  request(context:ActorContext,raw:unknown,idempotencyKey:string) {
    const input=inpatientTransferRequestInputSchema.parse(raw)
    return this.owner.commands.execute({context,input,idempotencyKey,operation:'inpatient.transfer.request',expectedVersions:{[`Encounter/${input.admissionId}`]:input.encounterVersion},dataSchema:inpatientTransfersSchema,
      authorize:()=>{this.owner.assertRole(context,['inpatient-doctor']);this.owner.orders.assertAdmitted(context,input.admissionId)}},transaction=>{
      const admission=this.owner.admissionBinding(context,input.admissionId)
      this.assertNoPending(context,input.admissionId)
      const ward=this.catalog(context).wards.find(ward=>ward.id===input.targetWardId && ward.id!==admission.row.ward_id)
      if(ward===undefined) throw new InpatientError('INPATIENT_TRANSFER_TARGET_INVALID','请选择不同的目标病区')
      const id=uuidv7(),now=this.owner.virtualTime(context)
      this.owner.database.driver.prepare(`INSERT INTO inpatient_transfer(workspace_id,epoch,transfer_id,admission_id,source_ward_id,source_organization_id,target_ward_id,target_organization_id,reason,status,requested_at,requested_by)
        VALUES(?,?,?,?,?,?,?,?,?,'requested',?,?)`).run(context.workspaceId,context.epoch,id,input.admissionId,admission.row.ward_id,admission.organizationId,ward.id,ward.organizationId,input.reason,now,context.actorId)
      const task=transaction.fhir.create(context,{resourceType:'Task',id,status:'requested',intent:'order',code:{coding:[{system:'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/task-kind',code:'inpatient-transfer'}],text:'住院转科'},
        for:{reference:`Patient/${admission.patientId}`},encounter:{reference:`Encounter/${input.admissionId}`},requester:{reference:`PractitionerRole/${context.practitionerRoleId}`},owner:{reference:`Organization/${ward.organizationId}`},authoredOn:now,description:input.reason})
      return {data:this.read(context,input.admissionId),effects:[{kind:'created' as const,reference:`Task/${id}`,versionId:task.meta!.versionId!}]}
    })
  }
  action(context:ActorContext,raw:unknown,idempotencyKey:string,action:'handover'|'receive'|'cancel') {
    const input=(action==='receive'?inpatientTransferReceiveInputSchema:inpatientTransferActionInputSchema).parse(raw)
    const authorize=()=>{
      this.owner.assertRole(context,action==='cancel'?['inpatient-doctor']:['ward-nurse'])
      const transfer=this.row(context,input.admissionId,input.transferId)
      if(action==='receive') {
        if(transfer.target_organization_id!==context.organizationId || transfer.target_ward_id!==context.locationId) throw new InpatientError('INPATIENT_SCOPE_FORBIDDEN','仅目标病区护士可以接收转科',403)
        if(transfer.status==='completed') this.owner.admissionBinding(context,input.admissionId)
      } else this.owner.orders.assertAdmitted(context,input.admissionId)
    }
    return this.owner.commands.execute({context,input,idempotencyKey,operation:`inpatient.transfer.${action}`,expectedVersions:{[`Encounter/${input.admissionId}`]:input.encounterVersion},dataSchema:inpatientTransfersSchema,authorize},transaction=>{
      const row=this.row(context,input.admissionId,input.transferId),task=transaction.fhir.read(context,'Task',row.transfer_id)
      if(row.version!==input.expectedTransferVersion || task.meta!.versionId!==String(row.version)) throw new InpatientError('INPATIENT_TRANSFER_VERSION_CONFLICT','转科任务版本已变化')
      const admission=z.object({status:z.string(),financial_status:z.string(),ward_id:z.string(),organization_id:z.string()}).parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_admission WHERE workspace_id=? AND epoch=? AND admission_id=?').get(context.workspaceId,context.epoch,input.admissionId))
      if(admission.status!=='admitted' || admission.financial_status!=='open' || admission.ward_id!==row.source_ward_id || admission.organization_id!==row.source_organization_id) throw new InpatientError('INPATIENT_TRANSFER_STATE_CONFLICT','本次住院已不在原病区或不能转科')
      if(action==='handover' && row.status!=='requested' || action==='receive' && row.status!=='handed-over' || action==='cancel' && !['requested','handed-over'].includes(row.status)) throw new InpatientError('INPATIENT_TRANSFER_STATE_CONFLICT','请按申请、原科交接、目标科接收顺序办理')
      const now=this.owner.virtualTime(context),effects:Array<{kind:'created'|'updated';reference:string;versionId:string}>=[]
      if(action!=='cancel') this.assertHandoverReady(context,input.admissionId)
      if(action==='receive') {
        const bedId=inpatientTransferReceiveInputSchema.parse(input).bedId
        const bed=this.catalog(context).beds.find(bed=>bed.id===bedId && bed.wardId===row.target_ward_id && bed.available)
        if(bed===undefined) throw new InpatientError('INPATIENT_BED_UNAVAILABLE','目标病区床位已占用或不属于目标病区')
        const encounter=this.owner.applyTransfer(context,input.admissionId,{bedId,wardId:row.target_ward_id,organizationId:row.target_organization_id},input.encounterVersion,now)
        effects.push({kind:'updated',reference:`Encounter/${input.admissionId}`,versionId:encounter.meta!.versionId!})
      }
      const next=action==='handover'?'handed-over':action==='receive'?'completed':'cancelled'
      const update=this.owner.database.driver.prepare(`UPDATE inpatient_transfer SET status=?,version=version+1,
        handed_over_at=CASE WHEN ?='handover' THEN ? ELSE handed_over_at END,handed_over_by=CASE WHEN ?='handover' THEN ? ELSE handed_over_by END,
        received_at=CASE WHEN ?='receive' THEN ? ELSE received_at END,received_by=CASE WHEN ?='receive' THEN ? ELSE received_by END,
        bed_id=CASE WHEN ?='receive' THEN ? ELSE bed_id END WHERE workspace_id=? AND epoch=? AND transfer_id=? AND version=?`)
        .run(next,action,now,action,context.actorId,action,now,action,context.actorId,action,'bedId' in input?input.bedId:null,context.workspaceId,context.epoch,row.transfer_id,row.version)
      if(update.changes!==1) throw new InpatientError('INPATIENT_TRANSFER_VERSION_CONFLICT','转科任务版本已变化')
      const updated=transaction.fhir.update(context,{...task,status:action==='handover'?'in-progress':next,lastModified:now},String(row.version))
      effects.push({kind:'updated',reference:`Task/${row.transfer_id}`,versionId:updated.meta!.versionId!})
      return {data:this.read(context,input.admissionId),effects}
    })
  }
}
