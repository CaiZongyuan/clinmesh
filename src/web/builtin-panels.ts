import { lazy } from 'react';

export const builtinPanels = {
  prescriptions: lazy(() => import('./modules/pharmacy/PrescriptionPanel').then(module => ({ default: module.PrescriptionPanel }))),
};
export const builtinStations = {
  'pharmacy.queue': lazy(() => import('./modules/pharmacy/DispenseDesk').then(module => ({ default: module.DispenseDesk }))),
};
