import { createRequire } from 'node:module';
import { cruise, type IConfiguration } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';

const { options, ...ruleSet }: IConfiguration = createRequire(import.meta.url)('../.dependency-cruiser.cjs');
const { output, exitCode } = await cruise(['src', 'scripts'], {
  ...options, ruleSet, validate: true, outputType: 'err',
}, {}, { tsConfig: extractTSConfig('tsconfig.json') });

console.log(output);
process.exitCode = exitCode;
