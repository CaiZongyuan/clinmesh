import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { lintTheme } from './lint-theme';

it('allows semantic UI in business views and reports each raw control, SDK import and palette violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'clinmesh-theme-'));
  const write = (path: string, source: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  try {
    write('src/web/Valid.tsx', `import { Button } from '../packages/ui-kit'; const note = 'Draft #123'; export const save = <Button title="Draft #123" className="text-primary">{note}</Button>;`);
    write('src/packages/ui-kit/lib/primitive.tsx', `import { Input } from '@ui-sdk/react/input'; const color = '#ffffff';`);
    write('src/packages/mod-lab/panel.css', '#abc { color: var(--ui-foreground); content: "Draft #123"; }');
    write('src/web/example.html', '<div title="Draft #123" style="color: var(--ui-info)">Draft #123</div>');
    expect(lintTheme(root)).toEqual([]);
    write('src/web/Invalid.tsx', `import { Button } from '@ui-sdk/react/button';\nexport const sample = <><button/><input/><select/><textarea/></>;`);
    write('src/web/example.html', '<section style="color: teal"><style>#abc { background: lab(50% 50 50); }</style></section>');
    write('src/packages/mod-lab/view.tsx', `const controls = import('@ui-sdk/react/input');\nexport const sample = <div className="hover:bg-blue-500 text-red-600 border-gray-300 border-bs-red-500 scrollbar-thumb-blue-500" style={{ color: 'rebeccapurple' }}/>;`);
    write('src/packages/mod-lab/panel.css', '.panel { color: #abc; background: rgb(1 2 3); border-color: hsl(20 20% 20%); color: red; background: oklch(.6 .2 40); }');
    const report = lintTheme(root).join('\n');
    for (const token of ['<button', '<input', '<select', '<textarea', '@ui-sdk/react/button', '@ui-sdk/react/input', 'bg-blue-500', 'text-red-600', 'border-gray-300', 'border-bs-red-500', 'scrollbar-thumb-blue-500', '#abc', 'rgb(', 'hsl(', 'oklch(', 'instead of red', 'rebeccapurple', 'instead of teal', 'lab(']) {
      expect(report, token).toContain(token);
    }
    expect(report).toContain('src/web/Invalid.tsx:2');
    expect(report).toContain('src/packages/mod-lab/view.tsx:2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
