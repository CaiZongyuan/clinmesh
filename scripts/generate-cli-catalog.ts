import { writeFile } from 'node:fs/promises';
import { describeOperation } from '../src/packages/operation-catalog';
import { builtinModules } from '../src/server/builtin-modules';
import { createOperationCatalog } from '../src/server/operation-catalog';

const { catalog } = createOperationCatalog(builtinModules);
const entries = catalog.entries.map(entry => JSON.stringify(describeOperation(entry.contract)));
await writeFile(new URL('../src/cli/operations.json', import.meta.url), `[\n${entries.join(',\n')}\n]\n`);
