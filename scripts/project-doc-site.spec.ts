import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRepositoryRef, resolveRepositoryUrl, rewriteMarkdown } from './project-doc-site.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'clinmesh-docs-'))
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs/index.md'), '# Index\n')
  writeFileSync(join(root, 'docs/target.md'), '# Target\n')
  writeFileSync(join(root, 'AGENTS.md'), '# Instructions\n')
  return root
}

describe('rewriteMarkdown', () => {
  it('rewrites a published source to its site route', () => {
    const root = fixture()
    const output = rewriteMarkdown('[Target](target.md)', {
      sourcePath: 'docs/index.md',
      route: 'index.md',
      pages: [
        { source: 'docs/index.md', route: 'index.md', label: 'Index', sidebar: null, section: 'Home', order: 0 },
        { source: 'docs/target.md', route: 'architecture/target.md', label: 'Target', sidebar: 'architecture', section: 'Architecture', order: 1 },
      ],
      repoRoot: root,
      repositoryRef: 'main',
      repositoryUrl: 'https://github.com/clinmesh/clinmesh',
    })
    expect(output).toBe('[Target](./architecture/target.md)')
  })

  it('rewrites an unpublished source to the repository', () => {
    const root = fixture()
    const output = rewriteMarkdown('[Instructions](../AGENTS.md)', {
      sourcePath: 'docs/index.md',
      route: 'index.md',
      pages: [{ source: 'docs/index.md', route: 'index.md', label: 'Index', sidebar: null, section: 'Home', order: 0 }],
      repoRoot: root,
      repositoryRef: 'main',
      repositoryUrl: 'https://github.com/clinmesh/clinmesh',
    })
    expect(output).toBe('[Instructions](https://github.com/clinmesh/clinmesh/blob/main/AGENTS.md)')
  })

  it('rejects a missing repository-relative target', () => {
    const root = fixture()
    expect(() => rewriteMarkdown('[Missing](missing.md)', {
      sourcePath: 'docs/index.md',
      route: 'index.md',
      pages: [{ source: 'docs/index.md', route: 'index.md', label: 'Index', sidebar: null, section: 'Home', order: 0 }],
      repoRoot: root,
      repositoryRef: 'main',
      repositoryUrl: 'https://github.com/clinmesh/clinmesh',
    })).toThrow('links to missing path')
  })
})

describe('documentation repository', () => {
  it('links local previews to the current repository and default branch', () => {
    expect(resolveRepositoryRef({})).toBe('main')
    expect(resolveRepositoryUrl({})).toBe('https://github.com/CaiZongyuan/clinmesh')
  })

  it('preserves an explicitly bound repository and revision', () => {
    expect(resolveRepositoryRef({ DOCS_REPOSITORY_REF: 'release-sha' })).toBe('release-sha')
    expect(resolveRepositoryUrl({ DOCS_REPOSITORY_URL: 'https://github.com/example/fork/' }))
      .toBe('https://github.com/example/fork')
  })
})
