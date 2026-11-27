import { voiceModule } from '../packages/mod-voice';
import legacyProcedures from '../../data/packs/legacy-procedure-services.json';
import legacyCdsEvidence from '../../data/packs/legacy-cds-evidence.json';
import { createBuiltinModules } from '../composition/modules';

export const builtinModules = createBuiltinModules(legacyProcedures, legacyCdsEvidence);
export const hostModules = (voiceEnabled?: string) => voiceEnabled === '0' ? builtinModules.filter(module => module !== voiceModule) : builtinModules;
