import { z } from 'zod'
import type { ClinicalQualityReceipt } from '@clinmesh/contracts/clinical-quality'
import { inpatientInvestigationAcknowledgeInputSchema, inpatientInvestigationActionInputSchema, inpatientInvestigationIssueInputSchema, inpatientInvestigationResponseSchema, inpatientInvestigationsSchema, inpatientInvestigationCatalogSchema } from '@clinmesh/contracts/inpatient-investigations'
import { resolveLaboratorySpecimenContainer } from '@clinmesh/core/laboratory-specimen-container'
import type { ImagingExamCode } from '@clinmesh/contracts/imaging'
import type { ActorContext } from './command-executor.ts'
import { ClinicalRequestKernel, laboratoryRequestPolicy } from './clinical-request-kernel.ts'
import { examinationRequestPolicy } from './examination-request-service.ts'
import { imagingRequestPolicy } from './imaging-request-service.ts'
import { classifyInpatientLaboratoryCategory } from './inpatient-laboratory-category.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import type { InpatientInvestigationsWorkflowPort } from './outpatient-workflow-context.ts'
import { inpatientInvestigationBillingSchema, inpatientLaboratoryConfiguration } from './inpatient-laboratory-config.ts'
import { buildFrozenCatalogCoverage, readConfigInsuranceCoverage } from './catalog-insurance-coverage.ts'

const requestSchema = z.object({ request_id: z.string(), case_id: z.string(), request_kind: z.enum(['laboratory','imaging','examination']), authored_by: z.string(),
  service_request_id: z.string(), execution_task_id: z.string(), diagnostic_report_id: z.string().nullable(),
  status: z.enum(['issued','accepted','in-progress','generation-failed','reported','acknowledged','cancelled']), version: z.number().int().positive() })

/** 住院送检与临床责任；执行和报告仍由原 LIS/RIS 适配器与申请内核拥有。 */
export class InpatientInvestigations {
  readonly #requests: ClinicalRequestKernel
  constructor(readonly owner: InpatientService, readonly workflow: InpatientInvestigationsWorkflowPort) { this.#requests = new ClinicalRequestKernel(owner.database) }
  assertNoPending(context: ActorContext, admissionId: string) {
    if (this.owner.database.driver.prepare(`SELECT 1 FROM inpatient_investigation i JOIN laboratory_request r
      ON r.workspace_id=i.workspace_id AND r.epoch=i.epoch AND r.request_id=i.request_id
      WHERE i.workspace_id=? AND i.epoch=? AND i.admission_id=? AND r.status IN ('issued','accepted','in-progress','generation-failed')`)
      .get(context.workspaceId, context.epoch, admissionId)) throw new InpatientError('INPATIENT_INVESTIGATION_PENDING', '仍有未完成或未取消的检查检验申请')
  }
  request(context: ActorContext, admissionId: string, requestId: string) {
    this.owner.assertRole(context,['inpatient-doctor','ward-nurse'])
    this.owner.admissionBinding(context,admissionId)
    const request=requestSchema.optional().parse(this.owner.database.driver.prepare(`SELECT r.* FROM laboratory_request r JOIN inpatient_investigation i ON i.workspace_id=r.workspace_id AND i.epoch=r.epoch AND i.request_id=r.request_id
      WHERE r.workspace_id=? AND r.epoch=? AND r.request_id=? AND i.admission_id=?`).get(context.workspaceId,context.epoch,requestId,admissionId))
    if(request===undefined) throw new InpatientError('INPATIENT_INVESTIGATION_NOT_FOUND','未找到本次住院检查',404)
    return request
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertRole(context,['inpatient-doctor','ward-nurse'])
    this.owner.admissionBinding(context,admissionId)
    return this.readSnapshot(context, admissionId)
  }
  readSnapshot(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    const binding = this.owner.readAdmissionBinding(context, admissionId)
    const scoped: ActorContext = context.roleCode === 'medical-records'
      ? { ...context, roleCode: 'inpatient-doctor', organizationId: binding.row.organization_id, locationId: binding.row.ward_id }
      : context
    const sent = z.array(z.object({request_id:z.string(),sent_at:z.string(),sent_by:z.string()})).parse(this.owner.database.driver.prepare(
      'SELECT request_id,sent_at,sent_by FROM inpatient_investigation WHERE workspace_id=? AND epoch=? AND admission_id=? AND sent_at IS NOT NULL ORDER BY julianday(sent_at),request_id').all(context.workspaceId,context.epoch,admissionId))
    const postopRows = z.array(z.object({ request_id: z.string(), surgery_execution_id: z.string() })).parse(
      this.owner.database.driver.prepare(
        'SELECT request_id, surgery_execution_id FROM inpatient_postoperative_investigation WHERE workspace_id=? AND epoch=? AND admission_id=?',
      ).all(context.workspaceId, context.epoch, admissionId),
    )
    const postopByRequestId = new Map(postopRows.map(row => [row.request_id, row.surgery_execution_id]))
    const attachSurgery = <T extends { id: string }>(items: T[]) => items.map(item => {
      const surgeryExecutionId = postopByRequestId.get(item.id)
      return surgeryExecutionId === undefined ? item : { ...item, surgeryExecutionId }
    })
    return inpatientInvestigationsSchema.parse({
      admissionId,
      laboratoryRequests: attachSurgery(this.workflow.inpatientLaboratoryRequests(scoped, admissionId)),
      imagingRequests: attachSurgery(this.workflow.imaging.state(scoped, admissionId).requests),
      examinationRequests: attachSurgery(this.workflow.examination.state(scoped, admissionId).requests),
      sent: sent.map(row => ({ requestId: row.request_id, sentAt: row.sent_at, sentBy: row.sent_by })),
    })
  }
  catalog(context: ActorContext, ready: ReadonlySet<ImagingExamCode>) {
    this.owner.assertRole(context,['inpatient-doctor','ward-nurse'])
    const rows=z.array(z.object({service_id:z.string(),version:z.number(),config_json:z.string()})).parse(this.owner.database.driver.prepare(
      'SELECT * FROM hospital_service_catalog WHERE workspace_id=? AND epoch=? AND active=1 ORDER BY name_zh,service_id').all(context.workspaceId,context.epoch))
    return inpatientInvestigationCatalogSchema.parse({items:rows.flatMap<z.infer<typeof inpatientInvestigationCatalogSchema>['items'][number]>(row=>{
      const raw: unknown = JSON.parse(row.config_json)
      const record = z.record(z.string(), z.unknown()).safeParse(raw), config = record.success ? record.data : {}
      const examination = z.object({name:z.string(),examCode:z.enum(['ecg-12-lead','tte'])}).safeParse(config.examinationService)
      const imaging = z.object({name:z.string(),examCode:z.enum(['chest-radiograph','chest-ct-plain'])}).safeParse(config.imagingService)
      const billing = inpatientInvestigationBillingSchema.safeParse(config.inpatientInvestigationBilling)
      if(examination.success && billing.success) return [{id:row.service_id,kind:'examination' as const,display:examination.data.name,version:row.version,priceFen:billing.data.priceFen,available:true,indicationCodes:[]}]
      if(imaging.success && billing.success) return [{id:row.service_id,kind:'imaging' as const,display:imaging.data.name,version:row.version,priceFen:billing.data.priceFen,available:ready.has(imaging.data.examCode),indicationCodes:[]}]
      const laboratory = inpatientLaboratoryConfiguration(raw)
      if(laboratory.service?.doctorOrderable) {
        const { priceFen, missingFields, service } = laboratory, available = missingFields.length === 0
        const isPanel = service.componentServiceIds.length > 0
        const laboratoryCategory = classifyInpatientLaboratoryCategory({
          hasPciSupplement: config.pciDataSupplement !== undefined && config.pciDataSupplement !== null,
          localCode: service.localCode,
          referenceCode: service.referenceConcept.code,
        })
        const specimenContainer = resolveLaboratorySpecimenContainer({
          referenceCode: service.referenceConcept.code,
          specimen: service.specimen,
          specimenContainer: service.specimenContainer,
        })
        const assayKeys = Array.from(new Set(
          service.reportDefinition.results.length > 0
            ? service.reportDefinition.results.map(result => `${result.referenceConcept.system}#${result.referenceConcept.code}`)
            : [`${service.referenceConcept.system}#${service.referenceConcept.code}`],
        ))
        return [{id:row.service_id,kind:'laboratory' as const,display:service.nameZh,version:row.version,...(priceFen===undefined?{}:{priceFen}),available,
          ...(available?{}:{unavailableReason:priceFen===undefined?'unpriced' as const:'not-offered' as const}),indicationCodes:service.allowedIndicationCodes,
          isPanel,...(isPanel?{memberCount:service.componentServiceIds.length}:{}),assayKeys,laboratoryCategory,specimen:service.specimen.display,specimenContainer}]
      }
      return []
    })})
  }
  issue(context: ActorContext, raw: unknown, idempotencyKey: string, ready: ReadonlySet<ImagingExamCode>) {
    const input=inpatientInvestigationIssueInputSchema.parse(raw)
    return this.owner.commands.execute({context,input,idempotencyKey,operation:'inpatient.investigation.issue',expectedVersions:{[`Encounter/${input.admissionId}`]:input.encounterVersion},
      dataSchema:inpatientInvestigationsSchema,authorize:()=>{this.owner.assertRole(context,['inpatient-doctor']);this.owner.orders.assertAdmitted(context,input.admissionId)}},transaction=>{
      this.owner.assertNotArchived(context,input.admissionId)
      if (input.surgeryExecutionId !== undefined) this.owner.surgery.assertExecution(context, input.admissionId, input.surgeryExecutionId)
      const available=this.catalog(context,ready).items.find(item=>item.id===(input.selection.kind!=='laboratory'?input.selection.serviceId:input.selection.catalogItemId) && item.kind===input.selection.kind)
      if(available===undefined || !available.available || available.priceFen===undefined) throw new InpatientError('INPATIENT_INVESTIGATION_UNAVAILABLE','该检查尚未开展或没有声明住院价目')
      if(available.version!==input.catalogVersion) throw new InpatientError('INPATIENT_INVESTIGATION_CATALOG_CONFLICT','检查目录或价目版本已变化，请重新选择')
      const versions={[`Encounter/${input.admissionId}`]:input.encounterVersion}
      const supportingInfo = input.surgeryExecutionId === undefined
        ? undefined
        : [{ reference: { reference: `Procedure/${input.surgeryExecutionId}` } }]
      let requestId:string
      let effects:Array<{kind:'created'|'updated';reference:string;versionId:string}>
      let clinicalQuality: ClinicalQualityReceipt | undefined
      const overrideOption = input.clinicalOverride === undefined ? {} : { clinicalOverride: input.clinicalOverride }
      if(input.selection.kind==='examination') {
        const draft=this.workflow.examination.state(context,input.admissionId)
        const saved=this.workflow.examination.applySaveDraft(transaction,{context,encounterId:input.admissionId,expectedDraftVersion:draft.draftVersion,expectedVersions:versions,idempotencyKey,indication:input.selection.indication,serviceId:input.selection.serviceId})
        const issued=this.workflow.examination.applyIssue(transaction,{...overrideOption,context,encounterId:input.admissionId,expectedDraftVersion:saved.data.draftVersion,expectedVersions:versions,idempotencyKey,readyExamCodes:new Set(['ecg-12-lead','tte']),...(supportingInfo===undefined?{}:{supportingInfo})})
        requestId=issued.data.request.id;effects=issued.effects;clinicalQuality=issued.clinicalQuality
      } else if(input.selection.kind==='imaging') {
        const draft=this.workflow.imaging.state(context,input.admissionId)
        const saved=this.workflow.imaging.applySaveDraft(transaction,{context,encounterId:input.admissionId,expectedDraftVersion:draft.draftVersion,expectedVersions:versions,idempotencyKey,
          indication:input.selection.indication,serviceId:input.selection.serviceId})
        const issued=this.workflow.imaging.applyIssue(transaction,{...overrideOption,context,encounterId:input.admissionId,expectedDraftVersion:saved.data.draftVersion,expectedVersions:versions,idempotencyKey,readyExamCodes:ready,...(supportingInfo===undefined?{}:{supportingInfo})})
        requestId=issued.data.request.id;effects=issued.effects;clinicalQuality=issued.clinicalQuality
      } else {
        const current=z.object({version:z.number()}).optional().parse(this.owner.database.driver.prepare('SELECT version FROM laboratory_request_state WHERE workspace_id=? AND epoch=? AND case_id=?').get(context.workspaceId,context.epoch,input.admissionId))
        const saved=this.workflow.applySaveLaboratoryRequestDraft(transaction,{context,encounterId:input.admissionId,expectedDraftVersion:current?.version??0,expectedVersions:versions,idempotencyKey,
          catalogItemId:input.selection.catalogItemId,indicationCode:input.selection.indicationCode})
        const issued=this.workflow.applyIssueLaboratoryRequest(transaction,{...overrideOption,context,encounterId:input.admissionId,expectedDraftVersion:saved.data.draftVersion,expectedVersions:versions,idempotencyKey,...(supportingInfo===undefined?{}:{supportingInfo})})
        requestId=issued.data.request.id;effects=issued.effects;clinicalQuality=issued.clinicalQuality
      }
      const stored=z.object({config_json:z.string()}).parse(this.owner.database.driver.prepare('SELECT config_json FROM hospital_service_catalog WHERE workspace_id=? AND epoch=? AND service_id=?').get(context.workspaceId,context.epoch,available.id))
      const config: unknown = JSON.parse(stored.config_json)
      const definition=input.selection.kind==='laboratory' ? inpatientLaboratoryConfiguration(config).chargeDefinition
        : z.object({inpatientInvestigationBilling:inpatientInvestigationBillingSchema}).parse(config).inpatientInvestigationBilling
      if(definition===undefined||definition.priceFen!==available.priceFen)throw new InpatientError('INPATIENT_INVESTIGATION_CATALOG_CONFLICT','检查冻结收费定义不一致')
      const coverage = input.selection.kind === 'imaging'
        ? readConfigInsuranceCoverage(stored.config_json, 'inpatientInvestigationBilling') ?? readConfigInsuranceCoverage(stored.config_json, 'imagingService')
        : input.selection.kind === 'examination'
          ? readConfigInsuranceCoverage(stored.config_json, 'examinationService')
          : readConfigInsuranceCoverage(stored.config_json, 'laboratoryService')
      const insuranceCoverage = buildFrozenCatalogCoverage(
        `synthetic-inpatient-${input.selection.kind}:${available.id}`,
        `item-v${available.version}`,
        coverage,
      )
      this.owner.database.driver.prepare(`INSERT INTO inpatient_investigation(workspace_id,epoch,request_id,admission_id,price_fen,charge_definition_json) VALUES(?,?,?,?,?,?)`)
        .run(context.workspaceId,context.epoch,requestId,input.admissionId,available.priceFen,JSON.stringify({...definition,display:available.display,trigger:'execution-completed',serviceId:available.id,catalogVersion:available.version,insuranceCoverage}))
      if (input.surgeryExecutionId !== undefined) {
        this.owner.database.driver.prepare(
          'INSERT INTO inpatient_postoperative_investigation(workspace_id,epoch,admission_id,request_id,surgery_execution_id) VALUES(?,?,?,?,?)',
        ).run(context.workspaceId, context.epoch, input.admissionId, requestId, input.surgeryExecutionId)
      }
      return {data:this.read(context,input.admissionId),effects,...(clinicalQuality===undefined?{}:{clinicalQuality})}
    })
  }
  action(context: ActorContext, raw: unknown, idempotencyKey: string, action: 'send'|'cancel'|'retry') {
    const input=inpatientInvestigationActionInputSchema.parse(raw)
    return this.owner.commands.execute({context,input,idempotencyKey,operation:`inpatient.investigation.${action}`,expectedVersions:{},dataSchema:inpatientInvestigationResponseSchema.shape.data,
      authorize:()=>{this.owner.assertRole(context,action==='send'?['ward-nurse']:['inpatient-doctor']);this.owner.orders.assertAdmitted(context,input.admissionId)}},transaction=>{
      this.owner.assertNotArchived(context,input.admissionId)
      const request=this.request(context,input.admissionId,input.requestId)
      const service=transaction.fhir.read(context,'ServiceRequest',request.service_request_id),task=transaction.fhir.read(context,'Task',request.execution_task_id)
      if(request.version!==input.expectedRequestVersion || service.meta!.versionId!==input.serviceRequestVersion || task.meta!.versionId!==input.taskVersion) throw new InpatientError('INPATIENT_INVESTIGATION_VERSION_CONFLICT','检查申请或执行任务版本已变化')
      const policy=request.request_kind==='imaging'?imagingRequestPolicy:request.request_kind==='examination'?examinationRequestPolicy:laboratoryRequestPolicy
      const now=this.owner.virtualTime(context)
      let effects:Array<{kind:'created'|'updated';reference:string;versionId:string}>=[]
      if(action==='send') {
        if(request.status!=='issued') throw new InpatientError('INPATIENT_INVESTIGATION_STATE_CONFLICT','仅待送检申请可以送检')
        const changed=this.owner.database.driver.prepare(`UPDATE inpatient_investigation SET sent_at=?,sent_by=?,sent_by_practitioner_role_id=? WHERE workspace_id=? AND epoch=? AND request_id=? AND sent_at IS NULL`)
          .run(now,context.actorId,context.practitionerRoleId,context.workspaceId,context.epoch,request.request_id)
        if(changed.changes!==1) throw new InpatientError('INPATIENT_INVESTIGATION_STATE_CONFLICT','该申请已送检')
        transaction.enqueue({dedupKey:`${policy.dedupPrefix}:${request.request_id}:accept`,kind:`${request.request_kind}.accept-request`,payload:{requestId:request.request_id}})
        effects=[{kind:'created',reference:`InpatientInvestigationDispatch/${request.request_id}`,versionId:'1'}]
      } else if(action==='cancel') {
        const sent=this.owner.database.driver.prepare('SELECT 1 FROM inpatient_investigation WHERE workspace_id=? AND epoch=? AND request_id=? AND sent_at IS NOT NULL').get(context.workspaceId,context.epoch,request.request_id)
        if(sent!==undefined && request.status!=='generation-failed') throw new InpatientError('INPATIENT_INVESTIGATION_STATE_CONFLICT','已送检申请不能撤销，应继续完成报告')
        const cancelled=this.#requests.cancel(policy,transaction,context,request,{expectedRequestVersion:input.expectedRequestVersion,now,reasonCode:'no-longer-needed'})
        effects=[cancelled.serviceRequest,cancelled.task].map(resource=>({kind:'updated',reference:`${resource.resourceType}/${resource.id}`,versionId:resource.meta!.versionId!}))
      } else {
        const failure=z.object({generation_error_code:z.string().nullable()}).parse(this.owner.database.driver.prepare('SELECT generation_error_code FROM laboratory_request WHERE workspace_id=? AND epoch=? AND request_id=?').get(context.workspaceId,context.epoch,input.requestId))
        if(['INVESTIGATION_TRUTH_INCOMPATIBLE','INVESTIGATION_UNSUPPORTED'].includes(failure.generation_error_code??'')) throw new InpatientError('INPATIENT_INVESTIGATION_STATE_CONFLICT','不支持或来源不相容的检验不可重试，请取消申请')
        this.#requests.assertRetryable(policy,context,request,input.expectedRequestVersion)
        const updated=this.#requests.retryGeneration(policy,transaction,context,request,now)
        effects=[{kind:'updated',reference:`Task/${updated.id}`,versionId:updated.meta!.versionId!}]
      }
      return {data:this.read(context,input.admissionId),effects}
    })
  }
  acknowledge(context: ActorContext, raw: unknown, idempotencyKey: string, studyAvailable: boolean) {
    const input=inpatientInvestigationAcknowledgeInputSchema.parse(raw)
    return this.owner.commands.execute({context,input,idempotencyKey,operation:'inpatient.investigation.acknowledge',expectedVersions:{[`DiagnosticReport/${input.diagnosticReportId}`]:input.diagnosticReportVersion},dataSchema:inpatientInvestigationsSchema,
      authorize:()=>{this.owner.assertRole(context,['inpatient-doctor']);this.owner.admissionBinding(context,input.admissionId)}},transaction=>{
      this.owner.assertNotArchived(context,input.admissionId)
      const request=this.request(context,input.admissionId,input.requestId)
      const service=transaction.fhir.read(context,'ServiceRequest',request.service_request_id),task=transaction.fhir.read(context,'Task',request.execution_task_id)
      if(service.meta!.versionId!==input.serviceRequestVersion || task.meta!.versionId!==input.taskVersion) throw new InpatientError('INPATIENT_INVESTIGATION_VERSION_CONFLICT','检查申请或执行任务版本已变化')
      const policy=request.request_kind==='imaging'?imagingRequestPolicy:request.request_kind==='examination'?examinationRequestPolicy:laboratoryRequestPolicy
      const acknowledgement=this.#requests.acknowledge(policy,transaction,context,request,{diagnosticReportId:input.diagnosticReportId,expectedRequestVersion:input.expectedRequestVersion,now:this.owner.virtualTime(context),
        assertReportContent:()=>{
          const facts=this.read(context,input.admissionId)
          const projected=(request.request_kind==='imaging'?facts.imagingRequests:request.request_kind==='examination'?facts.examinationRequests:facts.laboratoryRequests).find(item=>item.id===request.request_id)
          if(projected?.report?.diagnosticReportId!==input.diagnosticReportId) throw new InpatientError('INPATIENT_INVESTIGATION_STATE_CONFLICT','仅可确认本次检查的当前正式报告')
          if(request.request_kind==='imaging' && !studyAvailable) throw new InpatientError('IMAGING_STUDY_UNAVAILABLE','影像当前不可读取，不能确认已阅')
        }})
      return {data:this.read(context,input.admissionId),effects:acknowledgement.created?[{kind:'created' as const,reference:`ReportAcknowledgement/${acknowledgement.acknowledgementId}`,versionId:'1'}]:[]}
    })
  }
}
