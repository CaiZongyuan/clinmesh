import { createPharmacyModule } from '../packages/mod-pharmacy';
import { createBillingModule } from '../packages/mod-billing';
import { createDrgModule, regionalPayer } from '../packages/mod-drg-cn';
import { createLabModule } from '../packages/mod-lab';
import { createInpatientModule } from '../packages/mod-inpatient';
import legacyProcedures from '../../data/packs/legacy-procedure-services.json';

const billing = createBillingModule({ payerBenefit: regionalPayer });
export const builtinModules = [billing, createDrgModule(billing), createLabModule({ billing, legacyProcedures }), createPharmacyModule(billing), createInpatientModule(billing)];
