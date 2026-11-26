import { createLabModule } from '../packages/mod-lab';
import legacyProcedures from '../../data/packs/legacy-procedure-services.json';

export const clinicalModules = [createLabModule({ legacyProcedures })];
