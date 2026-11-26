import { createPharmacyModule } from '../packages/mod-pharmacy';
import { createBillingModule } from '../packages/mod-billing';
import { createDrgModule, regionalPayer } from '../packages/mod-drg-cn';

const billing = createBillingModule({ payerBenefit: regionalPayer });
export const builtinModules = [billing, createDrgModule(billing), createPharmacyModule(billing)];
