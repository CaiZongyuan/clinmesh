import { mkdirSync, mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyMarkdown } from './verify-docs';

function check(content: string, linked: Record<string, string> = {}) {
  using directory = mkdtempDisposableSync(join(process.cwd(), 'node_modules', '.clinmesh-docs-'));
  const documents = { 'README.md': content, ...linked };
  for (const [file, text] of Object.entries(documents)) {
    const path = join(directory.path, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return verifyMarkdown(directory.path, Object.keys(documents));
}

it('resolves local links, duplicate GitHub headings and explicit anchors', () => {
  const guide = { 'docs/guide.md': '# 接口\n\n## `Store` 入口\n\n## Store 入口\n\n<a name="manual"></a>\n' };
  expect(check('[接口](docs/guide.md#store-%E5%85%A5%E5%8F%A3-1)\n', guide)).toEqual([]);
  expect(check('[跳转](docs/guide.md#manual)\n', guide)).toEqual([]);
  expect(check('[接口](docs/guide.md#missing)\n', guide)).toContainEqual(expect.stringContaining('docs/guide.md#missing'));
  expect(check('![图](absent.webp)\n')).toContainEqual(expect.stringContaining('absent.webp'));
});

it('requires exactly one trailing LF and rejects CRLF', () => {
  for (const malformed of ['# End', '# End\n\n', '# End\r\n']) {
    expect(check(malformed)).toContainEqual(expect.stringContaining('LF'));
  }
});

it('requires every local path segment to match its repository spelling', () => {
  expect(check('[valid](Docs/Guide.md) [file](Docs/guide.md) [directory](docs/Guide.md)\n', { 'Docs/Guide.md': '# Guide\n' }))
    .toEqual([expect.stringContaining('Docs/guide.md'), expect.stringContaining('docs/Guide.md')]);
});

it('derives anchors from the visible heading text, not its HTML tags', () => {
  expect(check('## <em>Port</em>\n\n[Jump](#port)\n')).toEqual([]);
});
