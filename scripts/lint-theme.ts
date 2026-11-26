import { globSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import ts from 'typescript';

const rawPalette = /\b[a-z][\w-]*-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-\d{2,3})\b/g;
const colorTokens = /\/\*[\s\S]*?\*\/|url\((?:[^()'"]|'[^']*'|"[^"]*")*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[\da-f]+\b|(?:rgba?|hsla?|hwb|(?:ok)?l(?:ab|ch)|color|device-cmyk)\s*\(|[\w-]+/gi;
const namedColors = new Set(Object.keys(createRequire(import.meta.url)('color-name')));
const rawControl = /^(?:button|input|select|textarea)$/;
type Report = (offset: number, token: string) => void;

function acceptsColor(name: string) {
  const property = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  return /^(?:--|color$|(?:background|border|outline|fill|stroke)(?:-|$))|(?:-color|-shadow)$/.test(property);
}

function inspectColor(value: string, offset: number, report: Report) {
  for (const match of value.matchAll(colorTokens)) {
    const token = match[0].toLowerCase();
    if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(token) || token.endsWith('(') || namedColors.has(token)) report(offset + match.index, match[0]);
  }
}

function inspectUtilities(value: string, offset: number, report: Report) {
  for (const match of value.matchAll(rawPalette)) report(offset + match.index, match[0]);
  for (const match of value.matchAll(/\[([^\]]+)\]/g)) inspectColor(match[1]!, offset + match.index + 1, report);
}

function inspectCss(css: string, offset: number, report: Report) {
  const root = postcss.parse(css);
  root.walkDecls(declaration => {
    if (!acceptsColor(declaration.prop)) return;
    const start = offset + (declaration.source?.start?.offset ?? 0) + declaration.prop.length + (declaration.raws.between?.length ?? 1);
    inspectColor(declaration.value, start, report);
    for (const match of declaration.value.matchAll(rawPalette)) report(start + match.index, match[0]);
  });
  root.walkAtRules('apply', rule => inspectUtilities(rule.params, offset + (rule.source?.start?.offset ?? 0), report));
}

function inspectHtml(source: string, report: Report) {
  function visit(node: DefaultTreeAdapterMap['node']) {
    if ('tagName' in node && node.sourceCodeLocation) {
      const location = node.sourceCodeLocation;
      if (rawControl.test(node.tagName)) report(location.startOffset, `<${node.tagName}`);
      for (const { name, value } of node.attrs) {
        const start = location.attrs?.[name]?.startOffset ?? location.startOffset;
        if (name === 'class') inspectUtilities(value, start, report);
        if (name === 'style') inspectCss(value, start, report);
        if (acceptsColor(name)) inspectColor(value, start, report);
      }
      if (node.tagName === 'style' && location.startTag && location.endTag) {
        inspectCss(source.slice(location.startTag.endOffset, location.endTag.startOffset), location.startTag.endOffset, report);
      }
      if ('content' in node) visit(node.content);
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(source, { sourceCodeLocationInfo: true }));
}

function scansModulePath(node: ts.Node) {
  const parent = node.parent;
  return ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) ||
    (ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || parent.expression.getText() === 'require'));
}

function inspectScriptValue(node: ts.StringLiteralLike | ts.TemplateLiteralToken, source: ts.SourceFile, report: Report) {
  const offset = node.getStart(source) + 1;
  for (let context: ts.Node | undefined = node.parent; context && !ts.isStatement(context); context = context.parent) {
    if (ts.isPropertyAssignment(context) || ts.isJsxAttribute(context) || ts.isVariableDeclaration(context)) {
      const name = context.name.getText(source).replace(/^['"]|['"]$/g, '');
      if (acceptsColor(name)) return inspectColor(node.text, offset, report);
      if (/class(?:es|name)?$/i.test(name)) return inspectUtilities(node.text, offset, report);
    }
    if (ts.isCallExpression(context) && /^(?:cn|clsx|classnames|twMerge)$/.test(context.expression.getText(source))) return inspectUtilities(node.text, offset, report);
  }
  if (/^[\w:!\s/.[\]#%-]+$/.test(node.text)) {
    for (const match of node.text.matchAll(rawPalette)) report(offset + match.index, match[0]);
  }
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
    if (/\.css$/i.test(file)) { inspectCss(source, 0, report); continue; }
    if (/\.html$/i.test(file)) { inspectHtml(source, report); continue; }
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node) {
      if (ts.isJsxOpeningLikeElement(node) && rawControl.test(node.tagName.getText(tree))) report(node.getStart(tree), `<${node.tagName.getText(tree)}`);
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddleOrTemplateTail(node)) {
        if (/^@ui-sdk\/react(?:\/|$)/.test(node.text) && scansModulePath(node)) report(node.getStart(tree), node.text);
        else inspectScriptValue(node, tree, report);
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
