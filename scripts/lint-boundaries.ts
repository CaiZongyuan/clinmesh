import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cruise, format, type IConfiguration } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';

const { options, ...ruleSet }: IConfiguration = createRequire(import.meta.url)('../.dependency-cruiser.cjs');
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0').filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) && existsSync(file));
const { output } = await cruise(files, {
  ...options, ruleSet, validate: true,
}, {}, { tsConfig: extractTSConfig('tsconfig.json') });

if (typeof output === 'string') throw new Error('Expected a dependency graph');
const paths = new Map(files.map(file => [file.toLowerCase(), file]));
const { output: report, exitCode } = await format(output, { outputType: 'err' });
console.log(report);
process.exitCode = exitCode;
for (const { source, dependencies } of output.modules) {
  for (const { resolved } of dependencies) {
    const canonical = paths.get(resolved.toLowerCase());
    if (canonical && canonical !== resolved) {
      console.error(`import-path-case: ${source} → ${resolved}; expected ${canonical}`);
      process.exitCode = 1;
    }
  }
}
