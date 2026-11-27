import { createPharmacyModule } from '../packages/mod-pharmacy';
import { createBillingModule } from '../packages/mod-billing';
import { createDrgModule, regionalPayer } from '../packages/mod-drg-cn';
import { createLabModule } from '../packages/mod-lab';
import { createImagingModule } from '../packages/mod-imaging';
import { createPathologyModule } from '../packages/mod-pathology';
import legacyProcedures from '../../data/packs/legacy-procedure-services.json';
import { createCdsModule } from '../packages/mod-cds';
import legacyCdsEvidence from '../../data/packs/legacy-cds-evidence.json';
import { fhirModule } from '../packages/mod-fhir-r5';

const billing = createBillingModule({ payerBenefit: regionalPayer });
export const builtinModules = [billing, createDrgModule(billing), createLabModule({ billing, legacyProcedures }), createPharmacyModule(billing), createImagingModule(billing), createPathologyModule(billing), createCdsModule(legacyCdsEvidence), fhirModule];
