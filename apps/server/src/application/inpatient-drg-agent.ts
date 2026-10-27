import { inpatientDrgAgentSchema } from '@clinmesh/contracts/inpatient-drg-agent'
import type { ActorContext } from './command-executor.ts'
import type { InpatientService } from './inpatient-service.ts'

export class InpatientDrgAgent {
  constructor(private readonly owner: InpatientService) {}

  read(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['inpatient-doctor', 'ward-nurse', 'medical-records'])
    this.owner.readAdmissionBinding(context, admissionId)
    return inpatientDrgAgentSchema.parse({ admissionId, taskId: null, status: 'inactive',
      basisFingerprint: null, stage: null, missing: [], failureCode: null, analysis: null, confirmedPlan: null })
  }
}
