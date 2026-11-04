import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const forbidden = /冻结|事实|口径|推演|派发|授权|版本|模型|草稿|仿真时间|虚拟时间|尚应收|净额/g

function visibleSystemTerms(source: string, name = 'fixture.tsx'): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const parent = node.parent
      const identifier = ts.isElementAccessExpression(parent) && parent.argumentExpression === node
        || (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node
        || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent)
      if (!identifier) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        for (const match of node.text.matchAll(forbidden)) found.push(`${name}:${line}: ${match[0]}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

it('旧的可见系统文案会失败，标识符、属性名和注释不会被当作界面文案', () => {
  expect(visibleSystemTerms('const Page = () => <p>DRG 推演 · 预览已冻结</p>')).toEqual([
    'fixture.tsx:1: 推演', 'fixture.tsx:1: 冻结',
  ])
  expect(visibleSystemTerms('const 模型 = source["模型"]; const labels = { "版本": id }; // 草稿')).toEqual([])
  expect(visibleSystemTerms('const Page = () => <p>DRG 预分组 · 本次结算金额已固定</p>')).toEqual([])
})

it('住院界面的中文可见常量遵守岗位术语表', async () => {
  const directory = fileURLToPath(new URL('./', import.meta.url))
  const files = (await readdir(directory)).filter(name => name.startsWith('inpatient-')
    && /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name))
  const found = (await Promise.all(files.map(async name => visibleSystemTerms(await readFile(`${directory}/${name}`, 'utf8'), name)))).flat()
  expect(found).toEqual([])
})
