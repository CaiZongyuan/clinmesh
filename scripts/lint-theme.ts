import { globSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformStyleAttribute } from 'lightningcss';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import ts from 'typescript';

const rawPalette = /\b[a-z][\w-]*-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-\d{2,3})\b/g;
const colorTokens = /\/\*[\s\S]*?\*\/|url\((?:[^()'"]|'[^']*'|"[^"]*")*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[\da-f]+\b|(?:rgba?|hsla?|hwb|(?:ok)?l(?:ab|ch)|color|device-cmyk)\s*\(|[\w-]+/gi;
const namedColors: Readonly<Record<string, number[]>> = createRequire(import.meta.url)('color-name');
const hexColor = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const rawControl = /^(?:button|input|select|textarea)$/;
type Report = (offset: number, token: string) => void;

function acceptsColor(name: string) {
  const property = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  return /^(?:--|color$|(?:background|border|outline|fill|stroke)(?:-|$))|(?:-color|-shadow)$/.test(property);
}

function parsedColors(property: string, value: string) {
  const colors = new Set<string>();
  let customSyntax = false;
  const resolved = value.replace(/var\(\s*--[\w-]+\s*(?:,\s*([^()]+))?\)/gi, (_, fallback: string | undefined) => fallback ?? 'currentcolor');
  transformStyleAttribute({ code: Buffer.from(`${property}:${resolved}`), visitor: {
    Declaration(declaration) { customSyntax = declaration.property === 'custom'; },
    Color(color) { if (typeof color === 'object' && color.type === 'rgb') colors.add([color.r, color.g, color.b].join()); },
  } });
  return { colors, customSyntax };
}

function inspectColor(value: string, offset: number, report: Report, property?: string) {
  let parsed: ReturnType<typeof parsedColors> | undefined;
  for (const match of value.matchAll(colorTokens)) {
    const token = match[0].toLowerCase();
    if (hexColor.test(token) || token.endsWith('(')) report(offset + match.index, match[0]);
    else if (Object.hasOwn(namedColors, token)) {
      if (property && !property.startsWith('--')) {
        parsed ??= parsedColors(property, value);
        if (!parsed.customSyntax && !parsed.colors.has(namedColors[token]!.join())) continue;
      }
      report(offset + match.index, match[0]);
    }
    else if (property && token.startsWith('--color-')) {
      for (const utility of token.matchAll(rawPalette)) report(offset + match.index + utility.index, utility[0]);
    }
  }
}

function inspectUtilities(value: string, offset: number, report: Report) {
  for (const match of value.matchAll(rawPalette)) report(offset + match.index, match[0]);
  for (const match of value.matchAll(/\[([^\]]+)\]/g)) inspectColor(match[1]!, offset + match.index + 1, report);
}

function inspectCss(css: string, offset: number, report: Report) {
  const root = postcss.parse(css);
  root.walkDecls(declaration => {
    const start = offset + (declaration.source?.start?.offset ?? 0) + declaration.prop.length + (declaration.raws.between?.length ?? 1);
    inspectColor(declaration.value, start, report, declaration.prop);
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

function inspectScript(source: ts.SourceFile, checker: ts.TypeChecker, report: Report) {
  const resolving = new Set<ts.VariableDeclaration>();

  function value(node: ts.Node | undefined, use: string) {
    if (!node) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddleOrTemplateTail(node)) {
      const offset = node.getStart(source) + 1;
      if (use === 'class') inspectUtilities(node.text, offset, report);
      else if (use === 'style') inspectCss(node.text, offset, report);
      else inspectColor(node.text, offset, report, use);
    } else if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.getSourceFile() === source &&
        (declaration.parent.flags & ts.NodeFlags.Const) && !resolving.has(declaration)) {
        resolving.add(declaration);
        value(declaration.initializer, use);
        resolving.delete(declaration);
      }
    } else if (ts.isJsxExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      value(node.expression, use);
    } else if (ts.isConditionalExpression(node)) {
      value(node.whenTrue, use);
      value(node.whenFalse, use);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const member of node.properties) {
        if (ts.isSpreadAssignment(member)) value(member.expression, use);
        else if (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) {
          if (use === 'class' && ts.isStringLiteralLike(member.name)) value(member.name, use);
          if (use === 'style') {
            const property = member.name.getText(source).replace(/^['"]|['"]$/g, '').replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
            value(ts.isPropertyAssignment(member) ? member.initializer : member.name, property);
          }
        }
      }
    } else if (use === 'class' && ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) value(element, use);
    } else if (use === 'class' && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      value(node.right, use);
    } else if (use === 'class' && ts.isTemplateExpression(node)) {
      value(node.head, use);
      for (const span of node.templateSpans) { value(span.expression, use); value(span.literal, use); }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isJsxOpeningLikeElement(node) && rawControl.test(node.tagName.getText(source))) report(node.getStart(source), `<${node.tagName.getText(source)}`);
    if (ts.isStringLiteralLike(node) && /^@ui-sdk\/react(?:\/|$)/.test(node.text) && scansModulePath(node)) report(node.getStart(source), node.text);
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === 'class' || name === 'className') value(node.initializer, 'class');
      else if (name === 'style' || acceptsColor(name)) value(node.initializer, name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`));
    }
    if (ts.isCallExpression(node) && /^(?:cn|clsx|classnames|twMerge)$/.test(node.expression.getText(source))) {
      for (const argument of node.arguments) value(argument, 'class');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

export function lintTheme(root: string) {
  const errors: string[] = [];
  const files = globSync(['src/web/**/*', 'src/packages/mod-*/**/*'], { cwd: root });
  const scripts = files.filter(file => /\.[cm]?[jt]sx?$/i.test(file)).map(file => resolve(root, file));
  const program = ts.createProgram(scripts, { allowJs: true, jsx: ts.JsxEmit.Preserve, noLib: true, noResolve: true, types: [], moduleDetection: ts.ModuleDetectionKind.Force });
  const checker = program.getTypeChecker();
  for (const file of files.filter(path => /\.(?:[cm]?[jt]sx?|css|html)$/i.test(path)).sort()) {
    const tree = program.getSourceFile(resolve(root, file));
    const source = tree?.text ?? readFileSync(resolve(root, file), 'utf8');
    const reported = new Set<string>();
    const report = (offset: number, token: string) => {
      const key = `${offset}:${token}`;
      if (reported.has(key)) return;
      reported.add(key);
      const line = source.slice(0, offset).split('\n').length;
      errors.push(`${file.replaceAll('\\', '/')}:${line}: use ui-kit controls and semantic tokens instead of ${token}`);
    };
    if (/\.css$/i.test(file)) { inspectCss(source, 0, report); continue; }
    if (/\.html$/i.test(file)) { inspectHtml(source, report); continue; }
    if (tree) inspectScript(tree, checker, report);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = lintTheme(process.cwd());
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Verified business views use ui-kit and semantic theme tokens.');
}
