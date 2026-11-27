import { lazy } from 'react';
import { LabTab } from './modules/lab/LabTab';

export const builtinPanels = {
  lab: LabTab,
  billing: lazy(() => import('./modules/billing/BillingPanel')),
  prescriptions: lazy(() => import('./modules/pharmacy/PrescriptionPanel').then(module => ({ default: module.PrescriptionPanel }))),
};
export const builtinStations = {
  'pharmacy.queue': { name: { en: 'Dispensing queue', zh: '待发药队列' }, component: lazy(() => import('./modules/pharmacy/DispenseDesk').then(module => ({ default: module.DispenseDesk }))) },
};
