import { createStudyModule, type DiagnosticBillingPort } from '../diagnostic-workflow';
import { CoreError } from '../platform';

export const createImagingModule = (billing?: DiagnosticBillingPort) => createStudyModule({
  kind: 'imaging', label: { en: 'Radiology', zh: '放射影像' }, gateLabel: { en: 'Radiology reports acknowledged', zh: '放射报告已阅' },
  validateHistory(_context, _encounter, priorSurgeryId) { if (priorSurgeryId) throw new CoreError(400, 'UNEXPECTED_SURGERY_LINK'); },
}, billing);
