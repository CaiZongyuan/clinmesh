# Agent Note: DSH 客户端语法压缩并保留可观察合同

Status: implemented

## Problem

[手术流程减负](https://github.com/CaiZongyuan/clinmesh/issues/489)集成后的 DSH 客户端经既有空白压缩仍为 5,017,317 字节，超过[5,000,000 字节预算](2026-10-07-dsh-client-size-budget.md)。样式已经由 Vite 压缩，再压缩只能减少 58 字节；Bun 的局部内联测量也不足以解决超限。需要减少实际产物，不改变功能、宿主加载方式或预算。

## Decision

`apps/dsh-web/src/compact-client.ts` 使用 Terser，在锁定 Surface builder 之后对 factory 正文进行一次受限语法及空白压缩，再执行原产物校验。它取代[空白压缩决策](2026-10-22-dsh-client-whitespace-compaction.md)中的 Bun Transpiler 选型及只压缩空白的限制；原 TypeScript AST、精确前后缀、lazy-CJS wrapper、宿主 `require`、module/exports 初始化与返回边界继续保留。转换不打包、不执行产物、不重新解析依赖，也不修改 vendor。Terser 5.50.0 已存在于依赖锁中，应用显式声明同版本构建依赖，避免依赖 Vite 的间接包提升。

压缩设置 `compress: { defaults: false, booleans: true }`，只开启布尔表达式缩写及压缩器对内建字面量的安全表示，不开启控制流折叠、死代码消除、内联或 tree shaking。`mangle: false` 保留绑定和属性名称，`keep_fnames` 与 `keep_classnames` 显式保留函数和类名；`ecma` 与共享 `tsconfig.base.json` 已有的 ES2023 对齐，输出保留 UTF-8 和内联许可证注释。Tool descriptor 仍由最终产物按名称提取并执行，不能以源代码测试替代。

## Alternatives considered

- 提高预算或删除功能：不能降低当前单文件的实际加载开销。
- 二次压缩 CSS、调整小依赖入口或只开启 Bun 内联：测量收益不足，额外转换也增加维护成本。
- 手工替换布尔值与 `undefined` 等文本：需要重新实现语法、作用域和优先级分析，容易改变字符串、属性名或求值顺序。
- esbuild 的完整语法优化：即使不改名，条件折叠也会把 `const x = true ? function() {} : function() {}` 的匿名名称从空串变成 `x`；开启名称修复会使产物再次超过预算。Terser 的窄规则集保留该可观察行为，并有对应回归。
- 标识符改名、重新打包或动态拆包：分别扩大名称合同、宿主 `require` 和单文件加载边界的风险，当前窄规则集已经满足预算。
- 叠加两轮压缩：重复解析和打印，没有必要；直接替换使实际转换范围与配置更容易审查。

## Consequences

压缩器的语义合同覆盖延迟宿主导入、多行字符串、正则、Unicode、许可证、求值顺序、短路、异常与 finally 副作用、可观察函数／类名称、内建字面量与同名局部变量、重复压缩稳定性和不匹配 wrapper 的拒绝。原 5 MB、外部模块、宿主 React 与 Tool 描述/schema 校验继续生效，真实 lazy-CJS 浏览器合同在宿主 React 18/19 的 ShadowRoot 中验证实际产物。

语法优化比单纯空白打印有更大的语义影响范围。升级 Terser、Bun 或 Surface builder 后必须运行这些合同，并比较完整构建后的字节数；不能用第三方入口文件大小或局部转换结果代替最终产物。浏览器合同证明受测入口，不代表覆盖所有业务分支，相关业务回归仍由原测试层拥有。
