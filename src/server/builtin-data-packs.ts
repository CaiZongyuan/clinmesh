import general from '../../data/packs/global-general/pack.json';
import cardiology from '../../data/packs/cn-cardiology/pack.json';
import { parseHospitalDataPack } from '../packages/data-pack';

export const BUILTIN_DATA_PACKS = Object.freeze({
  'global-general': parseHospitalDataPack(general),
  'cn-cardiology': parseHospitalDataPack(cardiology),
});
