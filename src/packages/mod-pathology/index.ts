import { readClinicalCase } from '../data-pack';
import { createStudyModule } from '../diagnostic-studies';
import type { DiagnosticBillingPort } from '../diagnostic-workflow';
import { CoreError } from '../platform';

export const createPathologyModule = (billing?: DiagnosticBillingPort) => createStudyModule({
  kind: 'pathology', label: { en: 'Pathology', zh: '病理会诊' }, gateLabel: { en: 'Pathology reports acknowledged', zh: '病理报告已阅' },
  validateHistory({ tx, at, moduleEnabled }, encounter, priorSurgeryId) {
    const patient = readClinicalCase(tx, at, encounter.source_case_id);
    if (patient?.priorHistory.surgeries?.some(surgery => surgery.id === priorSurgeryId)) return;
    if (moduleEnabled?.('mod-inpatient') && priorSurgeryId && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(priorSurgeryId)) {
      const stage = tx.list(at, 'ward_surgery_stages', { completed_execution_id: priorSurgeryId })[0];
      if (stage && tx.get(at, 'clinical_orders', stage.order_id)?.encounter_id === encounter.id) return;
    }
    throw new CoreError(409, 'VISIBLE_SURGERY_REQUIRED');
  },
}, billing);
