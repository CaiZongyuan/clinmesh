import { parseDocument } from 'yaml';
import { DataPackError } from './errors';
import { codingKey, validateReferences } from './references';
import { packSchema, type CatalogKind, type Coding, type HospitalDataPack } from './schema';

const compiled = new WeakMap<HospitalDataPack, ReturnType<typeof validateReferences>>();

function freezeTree(value: unknown) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
}

function decode(raw: string): unknown {
  try {
    const document = parseDocument(raw);
    if (document.errors.length || document.warnings.length) throw new Error();
    return document.toJS({ maxAliasCount: 0 });
  } catch { throw new DataPackError('INVALID_PACK', 'document'); }
}

export function parseHospitalDataPack(raw: unknown): HospitalDataPack {
  if (typeof raw === 'object' && raw !== null && compiled.has(raw as HospitalDataPack)) return raw as HospitalDataPack;
  const parsed = packSchema.safeParse(typeof raw === 'string' ? decode(raw) : raw);
  if (!parsed.success) throw new DataPackError('INVALID_PACK', parsed.error.issues[0]!.path.join('.'));
  compiled.set(parsed.data, validateReferences(parsed.data));
  freezeTree(parsed.data);
  return parsed.data;
}

export function findCatalogItem<Kind extends CatalogKind>(pack: HospitalDataPack, kind: Kind, coding: Coding): HospitalDataPack['catalog'][Kind][number] | undefined {
  const index = compiled.get(parseHospitalDataPack(pack))![kind];
  return index.get(codingKey(coding)) as HospitalDataPack['catalog'][Kind][number] | undefined;
}
