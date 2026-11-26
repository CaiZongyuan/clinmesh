import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const rawPalette = /\b(?:accent|bg|border(?:-[trblxyse])?|caret|decoration|divide|fill|from|outline|placeholder|ring(?:-offset)?|shadow|stroke|text|to|via|color)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-\d{2,3})\b/g;
const colorLiteral = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|\b(?:rgba?|hsla?)\s*\(/gi;
const rawControl = /^(?:button|input|select|textarea)$/;

function scansModulePath(node: ts.Node) {
  const parent = node.parent;
  return ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) ||
    (ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || parent.expression.getText() === 'require'));
}

export function lintTheme(root: string) {
  const errors: string[] = [];
  const files = globSync(['src/web/**/*', 'src/packages/mod-*/**/*'], { cwd: root });
  for (const file of files.filter(path => /\.(?:[cm]?[jt]sx?|css|html)$/i.test(path)).sort()) {
    const source = readFileSync(resolve(root, file), 'utf8');
    const report = (offset: number, token: string) => {
      const line = source.slice(0, offset).split('\n').length;
      errors.push(`${file.replaceAll('\\', '/')}:${line}: use ui-kit controls and semantic tokens instead of ${token}`);
    };
    const colors = (value: string, offset: number) => {
      for (const pattern of [rawPalette, colorLiteral]) {
        for (const match of value.matchAll(pattern)) report(offset + match.index, match[0]);
      }
    };
    if (/\.(css|html)$/i.test(file)) {
      const content = source.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ' '));
      colors(content, 0);
      if (/\.html$/i.test(file)) for (const tag of content.matchAll(/<(?:button|input|select|textarea)\b/gi)) report(tag.index, tag[0]);
      continue;
    }
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node) {
      if (ts.isJsxOpeningLikeElement(node) && rawControl.test(node.tagName.getText(tree))) report(node.getStart(tree), `<${node.tagName.getText(tree)}`);
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddleOrTemplateTail(node)) {
        if (/^@ui-sdk\/react(?:\/|$)/.test(node.text) && scansModulePath(node)) report(node.getStart(tree), node.text);
        else if (!(ts.isJsxAttribute(node.parent) && node.parent.name.getText(tree) === 'href')) colors(node.getText(tree), node.getStart(tree));
      }
      ts.forEachChild(node, inspect);
    }
    inspect(tree);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = lintTheme(process.cwd());
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Verified business views use ui-kit and semantic theme tokens.');
}
