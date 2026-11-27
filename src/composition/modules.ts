import { createPharmacyModule } from '../packages/mod-pharmacy';
import { createBillingModule } from '../packages/mod-billing';
import { createDrgModule, regionalPayer } from '../packages/mod-drg-cn';
import { createLabModule } from '../packages/mod-lab';
import { createImagingModule } from '../packages/mod-imaging';
import { createPathologyModule } from '../packages/mod-pathology';
import { createInpatientModule } from '../packages/mod-inpatient';
import { createCdsModule } from '../packages/mod-cds';
import { fhirModule } from '../packages/mod-fhir-r5';
import { voiceModule } from '../packages/mod-voice';

export function createBuiltinModules(legacyProcedures?: NonNullable<Parameters<typeof createLabModule>[0]>['legacyProcedures'], legacyCdsEvidence?: unknown) {
  const billing = createBillingModule({ payerBenefit: regionalPayer });
  return [billing, createDrgModule(billing), createLabModule({ billing, legacyProcedures }), createPharmacyModule(billing), createImagingModule(billing), createPathologyModule(billing), createInpatientModule(billing), createCdsModule(legacyCdsEvidence), fhirModule, voiceModule];
}
