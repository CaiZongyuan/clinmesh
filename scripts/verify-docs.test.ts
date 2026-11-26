import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { verifyMarkdown } from './verify-docs';

it('resolves local links and GitHub heading slugs, including duplicate headings', () => {
  const root = mkdtempSync(join(process.cwd(), 'node_modules', '.clinmesh-docs-'));
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'guide.md'), '# 接口\n\n## `Store` 入口\n\n## Store 入口\n\n<a name="manual"></a>\n');
    const check = (content: string) => {
      writeFileSync(join(root, 'README.md'), content);
      return verifyMarkdown(root, ['README.md', 'docs/guide.md']);
    };
    expect(check('[接口](docs/guide.md#store-%E5%85%A5%E5%8F%A3-1)\n')).toEqual([]);
    expect(check('[跳转](docs/guide.md#manual)\n')).toEqual([]);
    expect(check('[接口](docs/guide.md#missing)\n')).toContainEqual(expect.stringContaining('docs/guide.md#missing'));
    expect(check('![图](absent.webp)\n')).toContainEqual(expect.stringContaining('absent.webp'));
    for (const malformed of ['# End', '# End\n\n', '# End\r\n']) {
      expect(check(malformed)).toContainEqual(expect.stringContaining('LF'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
