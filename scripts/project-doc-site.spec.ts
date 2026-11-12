import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectMarkdownAnchors,
  resolveRepositoryRef,
  resolveRepositoryUrl,
  rewriteMarkdown,
  slugifyHeading,
} from './project-doc-site.ts'
import { validateAgentNotes } from './verify-agent-note-format.ts'
import { verifyMarkdownFiles } from './verify-docs.ts'

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

describe('heading anchors', () => {
  it('matches GitHub GFM heading slugs for numbered and punctuated Chinese headings', () => {
    expect(slugifyHeading('1.4 明确不做')).toBe('14-明确不做')
    expect(slugifyHeading('8.5 收费、支付与退款')).toBe('85-收费支付与退款')
    expect(slugifyHeading('4. 配置 AI Provider（患者档案必需）')).toBe('4-配置-ai-provider患者档案必需')
    expect(slugifyHeading('3.2 多种 Adapter、一个业务内核')).toBe('32-多种-adapter一个业务内核')
  })

  it('collects duplicate heading counters and explicit HTML anchor ids without false attribute matches', () => {
    const anchors = collectMarkdownAnchors([
      '<a id="database-operations"></a>',
      '<a name="legacy-anchor"></a>',
      '<div data-id="details" title=\'id="quoted"\'></div>',
      '<input name="ignored-input-name" />',
      '<!-- <div id="commented-out"></div> -->',
      '## 1.4 明确不做',
      '### `db:restore` 与权威合并',
      '## 1.4 明确不做-1',
      '## 1.4 明确不做',
    ].join('\n\n'))
    expect([...anchors]).toEqual([
      'database-operations',
      'legacy-anchor',
      '14-明确不做',
      'dbrestore-与权威合并',
      '14-明确不做-1',
      '14-明确不做-2',
    ])
  })
})

describe('verifyMarkdownFiles', () => {
  it('validates GFM heading anchors, explicit HTML ids, and source-blob line links while rejecting broken Markdown anchors', () => {
    const root = mkdtempSync(join(tmpdir(), 'clinmesh-verify-docs-'))
    mkdirSync(join(root, 'docs'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/example.ts'), 'export const answer = 42\n')
    writeFileSync(
      join(root, 'docs/target.md'),
      ['# 目标页', '', '<a id="database-operations"></a>', '', '## 1.4 明确不做', ''].join('\n'),
    )
    writeFileSync(
      join(root, 'docs/valid.md'),
      [
        '# 正常页',
        '',
        '- [章节](target.md#14-明确不做)',
        '- [显式锚点](target.md#database-operations)',
        '- [源码行号引用](../src/example.ts#L1-L5)',
        '- [同页章节](#正常页)',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(root, 'docs/broken.md'),
      [
        '# 断链页',
        '',
        '- [漂移锚点](target.md#_1-4-明确不做)',
        '- [Markdown 伪行号锚点](target.md#L1-L5)',
        '',
      ].join('\n'),
    )

    expect(verifyMarkdownFiles(root, ['docs/target.md', 'docs/valid.md'])).toEqual([])
    expect(verifyMarkdownFiles(root, ['docs/target.md', 'docs/broken.md'])).toEqual([
      'docs/broken.md: missing heading anchor "target.md#_1-4-明确不做"',
      'docs/broken.md: missing heading anchor "target.md#L1-L5"',
    ])
  })
})

describe('validateAgentNotes', () => {
  it('enforces implemented section allowlist, empty lifecycle directories, and repository doc URL rules', () => {
    const root = mkdtempSync(join(tmpdir(), 'clinmesh-agent-notes-'))
    mkdirSync(join(root, 'proposed/feature'), { recursive: true })
    mkdirSync(join(root, 'implemented/architecture'), { recursive: true })

    writeFileSync(
      join(root, 'implemented/architecture/2026-11-10-valid.md'),
      [
        '# Agent Note: 合法决策示例',
        '',
        'Status: implemented',
        '',
        '## Problem',
        '',
        '保留上游外部参考 [Medplum 文档](https://github.com/medplum/medplum/blob/main/docs/fhir.md)。',
        '',
        '## Decision',
        '',
        '使用仓库相对链接。',
        '',
        '## Alternatives considered',
        '',
        '- 方案一：拒绝。',
        '',
        '## Consequences',
        '',
        '构建通过。',
        '',
      ].join('\n'),
    )

    writeFileSync(
      join(root, 'implemented/architecture/2026-11-10-invalid.md'),
      [
        '# Agent Note: 非法章节与仓库 URL 示例',
        '',
        'Status: implemented',
        '',
        '## Problem',
        '',
        '引用 [本仓文档](https://github.com/CaiZongyuan/clinmesh/blob/main/docs/overview.md)。',
        '',
        '## Decision',
        '',
        '决策正文。',
        '',
        '## Alternatives considered',
        '',
        '- 备选。',
        '',
        '## Risks',
        '',
        '残留提案章节。',
        '',
        '## Consequences',
        '',
        '结果。',
        '',
      ].join('\n'),
    )

    const result = validateAgentNotes(root)
    expect(result.checked).toBe(2)
    expect(result.errors).toEqual([
      'structure: proposed/feature/ is empty',
      'format: implemented/architecture/2026-11-10-invalid.md — ## Risks is not an allowed implemented section',
      'format: implemented/architecture/2026-11-10-invalid.md — use repository-relative link instead of https://github.com/CaiZongyuan/clinmesh/blob/main/docs/',
    ])
  })
})
