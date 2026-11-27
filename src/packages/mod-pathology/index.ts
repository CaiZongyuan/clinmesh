import { readClinicalCase } from '../data-pack';
import { createStudyModule, type DiagnosticBillingPort } from '../diagnostic-workflow';
import { CoreError } from '../platform';

export const createPathologyModule = (billing?: DiagnosticBillingPort) => createStudyModule({
  kind: 'pathology', label: { en: 'Pathology', zh: '病理会诊' }, gateLabel: { en: 'Pathology reports acknowledged', zh: '病理报告已阅' },
  validateHistory({ tx, at }, encounter, priorSurgeryId) {
    const patient = readClinicalCase(tx, at, encounter.source_case_id);
    if (!patient?.priorHistory.surgeries?.some(surgery => surgery.id === priorSurgeryId)) throw new CoreError(409, 'VISIBLE_SURGERY_REQUIRED');
  },
}, billing);
