import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const errors: string[] = []

interface Rule {
  scope: string
  forbidden: RegExp
  message: string
}

const rules: Rule[] = [
  {
    scope: 'packages/contracts/**/*.{ts,tsx}',
    forbidden: /(?:from\s+['"](?:react|react-dom|react-native|electron)|\b(?:window|document|localStorage|process\.env)\b)/,
    message: 'contracts must stay independent of React and platform globals',
  },
  {
    scope: 'packages/core/**/*.{ts,tsx}',
    forbidden: /(?:from\s+['"](?:react-dom|react-native|electron)|\b(?:window|document|localStorage|process\.env)\b)/,
    message: 'core must stay independent of DOM, Electron, React Native, storage, and environment globals',
  },
  {
    scope: 'packages/ui/**/*.{ts,tsx}',
    forbidden: /from\s+['"]@clinmesh\/core(?:\/|['"])/,
    message: 'ui primitives must not depend on business core',
  },
  {
    scope: 'packages/views/**/*.{ts,tsx}',
    forbidden: /from\s+['"](?:vite|electron|expo|react-native|react-router-dom|next)(?:\/|['"])/,
    message: 'shared views must receive platform capabilities through adapters',
  },
  {
    scope: 'apps/mobile/**/*.{ts,tsx}',
    forbidden: /from\s+['"]@clinmesh\/(?:ui|views)(?:\/|['"])/,
    message: 'mobile must not import DOM UI or shared DOM views',
  },
]

for (const rule of rules) {
  for (const path of globSync(rule.scope, { cwd: root }).map(item => item.split(sep).join('/')).sort()) {
    const content = readFileSync(resolve(root, path), 'utf8')
    if (rule.forbidden.test(content)) errors.push(`${path}: ${rule.message}`)
  }
}

if (errors.length === 0) {
  console.log('verify-package-boundaries: package dependency rules satisfied.')
} else {
  console.error('verify-package-boundaries: violations found:')
  for (const error of errors) console.error(`  ${error}`)
  process.exitCode = 1
}
