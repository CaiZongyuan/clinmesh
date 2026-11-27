import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import project from '../package.json' with { type: 'json' };

export async function prepareCliPackage(directory: string) {
  const files = [project.bin.clinmesh, 'src/packages/operation-catalog/index.ts', 'skills/clinmesh/SKILL.md',
    ...(await readdir('src/cli', { withFileTypes: true })).filter(entry => entry.isFile() && /\.(ts|json)$/.test(entry.name)).map(entry => `src/cli/${entry.name}`)];
  for (const file of files) {
    const target = join(directory, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
  }
  const { name, version, type, engines, bin, packageManager, dependencies: { tsx, zod } } = project;
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name, version, type, engines, bin, packageManager, files, dependencies: { tsx, zod } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepareCliPackage(project.publishConfig.directory);
