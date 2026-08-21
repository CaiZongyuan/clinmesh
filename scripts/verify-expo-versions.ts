import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const mobilePackage = JSON.parse(readFileSync(resolve(root, 'apps/mobile/package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const bundled = JSON.parse(readFileSync(resolve(root, 'apps/mobile/node_modules/expo/bundledNativeModules.json'), 'utf8')) as Record<string, string>
const errors: string[] = []

function baseVersion(range: string): string {
  return range.replace(/^[~^]/, '')
}

for (const [name, actual] of Object.entries(mobilePackage.dependencies ?? {})) {
  const expected = bundled[name]
  if (expected !== undefined && baseVersion(actual) !== baseVersion(expected)) {
    errors.push(`${name}: package.json has ${actual}, Expo expects ${expected}`)
  }
}

if (errors.length === 0) {
  console.log('verify-expo-versions: direct mobile dependencies match the installed Expo SDK manifest.')
} else {
  console.error('verify-expo-versions: incompatible mobile dependencies:')
  for (const error of errors) console.error(`  ${error}`)
  process.exitCode = 1
}
