import { createPharmacyModule } from '../packages/mod-pharmacy';
import { createBillingModule } from '../packages/mod-billing';
import { createDrgModule, regionalPayer } from '../packages/mod-drg-cn';
import { createLabModule } from '../packages/mod-lab';
import legacyProcedures from '../../data/packs/legacy-procedure-services.json';
import { cdsModule } from '../packages/mod-cds';
import { fhirModule } from '../packages/mod-fhir-r5';

const billing = createBillingModule({ payerBenefit: regionalPayer });
export const builtinModules = [billing, createDrgModule(billing), createLabModule({ billing, legacyProcedures }), createPharmacyModule(billing), cdsModule, fhirModule];
