import type { BuiltInTheme, BuiltInThemeId, ThemeTokens } from './types.ts'
import { THEME_API_VERSION } from './types.ts'

function tokenBlock(selector: string, tokens: ThemeTokens): string {
  const entries = Object.entries(tokens)
  if (entries.length === 0) return ''
  const body = entries.map(([k, v]) => `  --${k}: ${v};`).join('\n')
  return `${selector} {\n${body}\n}`
}

export function compileBuiltInThemeCss(theme: BuiltInTheme): string {
  const blocks: string[] = []
  const lightBlock = tokenBlock(':root.theme-light, .clinmesh-web-root:not(.dark)', theme.tokens.light)
  const darkBlock = tokenBlock(':root.theme-dark, .clinmesh-web-root.dark', theme.tokens.dark)
  if (lightBlock) blocks.push(lightBlock)
  if (darkBlock) blocks.push(darkBlock)
  if (theme.extraCss) blocks.push(theme.extraCss.trim())
  return blocks.join('\n\n')
}

function makeBuiltIn(
  spec: Omit<BuiltInTheme, 'apiVersion' | 'builtIn' | 'author' | 'css'>,
): BuiltInTheme {
  const draft: BuiltInTheme = {
    ...spec,
    apiVersion: THEME_API_VERSION,
    builtIn: true,
    author: 'ClinMesh',
    css: '',
  }
  return {
    ...draft,
    css: compileBuiltInThemeCss(draft),
  }
}

export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [
  makeBuiltIn({
    id: 'default',
    name: '临床默认',
    enName: 'Clinical Default',
    version: '1.0.0',
    description: {
      'zh-CN': '100% 保持当前 ClinMesh 医疗基线不变（#f5f6f7 浅灰画布、纯白卡片与冷静蓝）。',
      'en-US': 'Preserves ClinMesh original clinical baseline unchanged (#f5f6f7 canvas, pure white cards, clinical blue).',
    },
    swatch: {
      light: {
        shell: '#eceff3',
        canvas: '#f5f6f7',
        surface: '#ffffff',
        border: '#dce0e5',
        selected: '#e9f0fc',
        fg: '#0f1115',
        muted: '#61666b',
        brand: '#1764c0',
        warn: '#875b0c',
        info: '#1764c0',
        ok: '#187442',
      },
      dark: {
        shell: '#101012',
        canvas: '#151517',
        surface: '#232324',
        border: '#383b42',
        selected: '#24344c',
        fg: '#f9fafb',
        muted: '#cfd3d6',
        brand: '#8dbbff',
        warn: '#f4ca7b',
        info: '#8dbbff',
        ok: '#7ddba4',
      },
    },
    options: [
      {
        id: 'accent',
        type: 'select',
        label: { 'zh-CN': '临床强调色', 'en-US': 'Clinical accent' },
        description: {
          'zh-CN': '默认保持原版临床蓝 #1764c0；可按个人偏好微调焦点与页签强调色。',
          'en-US': 'Defaults to original clinical blue #1764c0; optionally tune focus and tab accent.',
        },
        default: 'clinical-blue',
        choices: [
          { value: 'clinical-blue', label: { 'zh-CN': '临床蓝（原版）', 'en-US': 'Clinical Blue' }, swatch: '#1764c0' },
          { value: 'teal', label: { 'zh-CN': '院感青', 'en-US': 'Scrub Teal' }, swatch: '#0e7490' },
          { value: 'forest', label: { 'zh-CN': '深森绿', 'en-US': 'Clinical Green' }, swatch: '#166534' },
          { value: 'indigo', label: { 'zh-CN': '沉稳靛', 'en-US': 'Calm Indigo' }, swatch: '#4338ca' },
        ],
      },
    ],
    tokens: {
      light: {},
      dark: {},
    },
    extraCss: `
:root.theme-light[data-theme-option-accent="teal"], .clinmesh-web-root:not(.dark)[data-theme-option-accent="teal"] { --info: #0e7490; --ring: #0e7490; --accent-foreground: #0e7490; --brand: #0e7490; }
:root.theme-dark[data-theme-option-accent="teal"], .clinmesh-web-root.dark[data-theme-option-accent="teal"] { --info: #5eead4; --ring: #5eead4; --accent-foreground: #5eead4; --brand: #5eead4; }
:root.theme-light[data-theme-option-accent="forest"], .clinmesh-web-root:not(.dark)[data-theme-option-accent="forest"] { --info: #166534; --ring: #166534; --accent-foreground: #166534; --brand: #166534; }
:root.theme-dark[data-theme-option-accent="forest"], .clinmesh-web-root.dark[data-theme-option-accent="forest"] { --info: #86efac; --ring: #86efac; --accent-foreground: #86efac; --brand: #86efac; }
:root.theme-light[data-theme-option-accent="indigo"], .clinmesh-web-root:not(.dark)[data-theme-option-accent="indigo"] { --info: #4338ca; --ring: #4338ca; --accent-foreground: #4338ca; --brand: #4338ca; }
:root.theme-dark[data-theme-option-accent="indigo"], .clinmesh-web-root.dark[data-theme-option-accent="indigo"] { --info: #a5b4fc; --ring: #a5b4fc; --accent-foreground: #a5b4fc; --brand: #a5b4fc; }
`,
  }),

  makeBuiltIn({
    id: 'quiet-studio',
    name: '静谧极简',
    enName: 'Quiet Studio',
    version: '1.0.0',
    description: {
      'zh-CN': '低饱和中性 OKLCH 表面阶梯、轻盈呼吸圆角与柔和层次阴影。',
      'en-US': 'Low-chroma neutral OKLCH elevation ladder with gentle rounded surfaces.',
    },
    swatch: {
      light: {
        shell: '#f0f1f4',
        canvas: '#fafafa',
        surface: '#ffffff',
        border: '#e4e5ea',
        selected: '#eceef3',
        fg: '#14151a',
        muted: '#5f6370',
        brand: '#2b61d1',
        warn: '#a16207',
        info: '#2b61d1',
        ok: '#15803d',
      },
      dark: {
        shell: '#111216',
        canvas: '#18191e',
        surface: '#212228',
        border: '#343640',
        selected: '#2d2f3a',
        fg: '#f7f8fa',
        muted: '#a4a8b5',
        brand: '#7da8ff',
        warn: '#f5b942',
        info: '#7da8ff',
        ok: '#5cd68d',
      },
    },
    tokens: {
      light: {
        'app-shell': '#f0f1f4',
        background: '#fafafa',
        card: '#ffffff',
        popover: '#ffffff',
        sidebar: '#f6f7f9',
        secondary: '#eff0f4',
        muted: '#f3f4f7',
        accent: '#eceef3',
        'accent-foreground': '#1b47a8',
        foreground: '#14151a',
        'card-foreground': '#14151a',
        'popover-foreground': '#14151a',
        'muted-foreground': '#575b68',
        border: '#e4e5ea',
        input: '#cfd2dc',
        info: '#2b61d1',
        brand: '#2b61d1',
        ring: '#2b61d1',
        radius: '0.625rem',
        'surface-shadow': '0 1px 2px rgb(15 23 42 / 0.04), 0 1px 1px rgb(15 23 42 / 0.03)',
      },
      dark: {
        'app-shell': '#111216',
        background: '#18191e',
        card: '#212228',
        popover: '#292b33',
        sidebar: '#15161b',
        secondary: '#2d2f38',
        muted: '#262830',
        accent: '#2b3650',
        'accent-foreground': '#a8c6ff',
        foreground: '#f7f8fa',
        'card-foreground': '#f7f8fa',
        'popover-foreground': '#f7f8fa',
        'muted-foreground': '#b5b9c6',
        border: 'rgb(255 255 255 / 0.11)',
        input: '#535766',
        info: '#7da8ff',
        brand: '#7da8ff',
        ring: '#7da8ff',
        radius: '0.625rem',
        'surface-shadow': '0 1px 2px rgb(0 0 0 / 0.24)',
      },
    },
  }),

  makeBuiltIn({
    id: 'ward-precision',
    name: '精密查房',
    enName: 'Ward Precision',
    version: '1.0.0',
    description: {
      'zh-CN': '锐利 3px 技术圆角、冷灰蓝表面与高辨识实底导航选中态，适合数据密集查房。',
      'en-US': 'Crisp 3px technical geometry with cool clinical slate surfaces for high-density rounds.',
    },
    swatch: {
      light: {
        shell: '#e9edf4',
        canvas: '#f4f6fa',
        surface: '#ffffff',
        border: '#ced6e2',
        selected: '#1e5bb8',
        fg: '#17202e',
        muted: '#4e5d73',
        brand: '#1e5bb8',
        warn: '#a65d03',
        info: '#1e5bb8',
        ok: '#157a47',
      },
      dark: {
        shell: '#161d27',
        canvas: '#1d2532',
        surface: '#252f3f',
        border: '#3e4c63',
        selected: '#2f6fd0',
        fg: '#f3f6fb',
        muted: '#b5c2d6',
        brand: '#78b0ff',
        warn: '#f0b14b',
        info: '#78b0ff',
        ok: '#5ad197',
      },
    },
    tokens: {
      light: {
        'app-shell': '#e9edf4',
        background: '#f4f6fa',
        card: '#ffffff',
        popover: '#ffffff',
        sidebar: '#eef2f8',
        secondary: '#e6ecf5',
        muted: '#eef2f7',
        accent: '#dde9fb',
        'accent-foreground': '#174997',
        foreground: '#17202e',
        'card-foreground': '#17202e',
        'popover-foreground': '#17202e',
        'muted-foreground': '#4e5d73',
        border: '#ced6e2',
        input: '#98a7bd',
        primary: '#1e5bb8',
        'primary-foreground': '#ffffff',
        info: '#1e5bb8',
        brand: '#1e5bb8',
        ring: '#1e5bb8',
        radius: '0.25rem',
        'surface-shadow': '0 0 0 1px rgb(15 23 42 / 0.03), 0 1px 1px rgb(15 23 42 / 0.08)',
      },
      dark: {
        'app-shell': '#161d27',
        background: '#1d2532',
        card: '#252f3f',
        popover: '#2e394c',
        sidebar: '#19212d',
        secondary: '#313e52',
        muted: '#232c3b',
        accent: '#284574',
        'accent-foreground': '#bad7ff',
        foreground: '#f3f6fb',
        'card-foreground': '#f3f6fb',
        'popover-foreground': '#f3f6fb',
        'muted-foreground': '#b5c2d6',
        border: '#3e4c63',
        input: '#617491',
        primary: '#2f6fd0',
        'primary-foreground': '#ffffff',
        info: '#78b0ff',
        brand: '#78b0ff',
        ring: '#78b0ff',
        radius: '0.25rem',
      },
    },
  }),

  makeBuiltIn({
    id: 'warm-chart',
    name: '护眼暖纸',
    enName: 'Warm Chart',
    version: '1.0.0',
    description: {
      'zh-CN': '低蓝光暖米白纸面与温润炭黑字色，缓解长时段门诊阅览疲劳，支持切换病历阅读字体。',
      'en-US': 'Low-blue-light warm ivory paper & charcoal ink with optional clinical reading typography.',
    },
    swatch: {
      light: {
        shell: '#efebe2',
        canvas: '#faf7f0',
        surface: '#fffdf9',
        border: '#dfd8ca',
        selected: '#ede6d8',
        fg: '#29251f',
        muted: '#5f584d',
        brand: '#1f5e99',
        warn: '#9a6009',
        info: '#1f5e99',
        ok: '#276b48',
      },
      dark: {
        shell: '#171512',
        canvas: '#1e1c18',
        surface: '#282520',
        border: '#3e3a32',
        selected: '#363128',
        fg: '#f2ece1',
        muted: '#c2b9aa',
        brand: '#88b9e8',
        warn: '#eab863',
        info: '#88b9e8',
        ok: '#78c798',
      },
    },
    options: [
      {
        id: 'reading-font',
        type: 'select',
        label: { 'zh-CN': '病历阅读字体', 'en-US': 'Clinical reading font' },
        description: {
          'zh-CN': '作用于病历正文、问诊与助手内容区域。',
          'en-US': 'Applies to clinical prose, consultation records, and assistant markdown.',
        },
        default: 'default',
        choices: [
          { value: 'default', label: { 'zh-CN': '无衬线', 'en-US': 'Sans' } },
          { value: 'serif', label: { 'zh-CN': '衬线纸感', 'en-US': 'Serif' } },
          { value: 'mono', label: { 'zh-CN': '等宽数据', 'en-US': 'Mono' } },
        ],
      },
    ],
    tokens: {
      light: {
        'app-shell': '#efebe2',
        background: '#faf7f0',
        card: '#fffdf9',
        popover: '#fffdf9',
        sidebar: '#f4efe5',
        secondary: '#ede7db',
        muted: '#f3eee3',
        accent: '#eae2d2',
        'accent-foreground': '#1f5e99',
        foreground: '#29251f',
        'card-foreground': '#29251f',
        'popover-foreground': '#29251f',
        'muted-foreground': '#5c554a',
        border: '#dfd8ca',
        input: '#bdb3a0',
        primary: '#29251f',
        'primary-foreground': '#fffdf9',
        info: '#1f5e99',
        brand: '#1f5e99',
        ring: '#1f5e99',
        radius: '0.5rem',
      },
      dark: {
        'app-shell': '#171512',
        background: '#1e1c18',
        card: '#282520',
        popover: '#322e28',
        sidebar: '#1b1915',
        secondary: '#35312a',
        muted: '#25221d',
        accent: '#393329',
        'accent-foreground': '#a8cfef',
        foreground: '#f2ece1',
        'card-foreground': '#f2ece1',
        'popover-foreground': '#f2ece1',
        'muted-foreground': '#c2b9aa',
        border: '#3e3a32',
        input: '#686155',
        primary: '#f2ece1',
        'primary-foreground': '#1e1c18',
        info: '#88b9e8',
        brand: '#88b9e8',
        ring: '#88b9e8',
        radius: '0.5rem',
      },
    },
    extraCss: `
:root[data-theme-option-reading-font="serif"] [data-cm="clinical-prose"] { font-family: "Source Serif 4", Georgia, "Songti SC", "STSong", serif; }
:root[data-theme-option-reading-font="mono"] [data-cm="clinical-prose"] { font-family: var(--font-code); }
`,
  }),

  makeBuiltIn({
    id: 'scrub-fresh',
    name: '院感松石',
    enName: 'Scrub Fresh',
    version: '1.0.0',
    description: {
      'zh-CN': '清爽冷白底、院感松石青主操作与柔和斑马纹检验表。',
      'en-US': 'Crisp surgical-scrub cool white with hospital teal actions and subtle zebra lab rows.',
    },
    swatch: {
      light: {
        shell: '#ebf2f3',
        canvas: '#f6fafb',
        surface: '#ffffff',
        border: '#cde0e3',
        selected: '#e1f4f3',
        fg: '#142329',
        muted: '#4b636b',
        brand: '#0f766e',
        warn: '#9a6000',
        info: '#0e7490',
        ok: '#15803d',
      },
      dark: {
        shell: '#0d171a',
        canvas: '#132024',
        surface: '#1a2b30',
        border: '#2e4952',
        selected: '#1e3e44',
        fg: '#f0f7f8',
        muted: '#adc4ca',
        brand: '#4fd1c5',
        warn: '#f0b849',
        info: '#56ccf2',
        ok: '#68d391',
      },
    },
    tokens: {
      light: {
        'app-shell': '#ebf2f3',
        background: '#f6fafb',
        card: '#ffffff',
        popover: '#ffffff',
        sidebar: '#eff6f7',
        secondary: '#e6f0f2',
        muted: '#eff6f7',
        accent: '#e1f4f3',
        'accent-foreground': '#0d625c',
        foreground: '#142329',
        'card-foreground': '#142329',
        'popover-foreground': '#142329',
        'muted-foreground': '#475e66',
        border: '#cde0e3',
        input: '#92b0b5',
        primary: '#0f766e',
        'primary-foreground': '#ffffff',
        info: '#0e7490',
        brand: '#0f766e',
        ring: '#0f766e',
        radius: '0.4375rem',
      },
      dark: {
        'app-shell': '#0d171a',
        background: '#132024',
        card: '#1a2b30',
        popover: '#22373e',
        sidebar: '#101b1f',
        secondary: '#243a41',
        muted: '#17262b',
        accent: '#1e3e44',
        'accent-foreground': '#7ee4da',
        foreground: '#f0f7f8',
        'card-foreground': '#f0f7f8',
        'popover-foreground': '#f0f7f8',
        'muted-foreground': '#adc4ca',
        border: '#2e4952',
        input: '#4d6f7a',
        primary: '#4fd1c5',
        'primary-foreground': '#082120',
        info: '#56ccf2',
        brand: '#4fd1c5',
        ring: '#4fd1c5',
        radius: '0.4375rem',
      },
    },
    extraCss: `
:root[data-theme="scrub-fresh"] [data-slot="table"] tbody tr:nth-child(2n) { background-color: color-mix(in oklab, var(--muted) 65%, transparent); }
`,
  }),

  makeBuiltIn({
    id: 'ink-editorial',
    name: '墨线高辨识',
    enName: 'Ink Editorial',
    version: '1.0.0',
    description: {
      'zh-CN': '清晰墨线轮廓、4px 硬朗圆角与全套 Theme Options 演示（信号色 / 外框风格 / 硬投影）。',
      'en-US': 'High-definition ink borders, 4px crisp corners, and full Theme Options showcase.',
    },
    swatch: {
      light: {
        shell: '#ece6d8',
        canvas: '#faf8f2',
        surface: '#ffffff',
        border: '#1c1b18',
        selected: '#fae9a7',
        fg: '#171614',
        muted: '#4d4a42',
        brand: '#e5b82e',
        warn: '#9a5b04',
        info: '#1d4ed8',
        ok: '#15803d',
      },
      dark: {
        shell: '#09090b',
        canvas: '#171717',
        surface: '#202020',
        border: '#dedede',
        selected: '#403718',
        fg: '#f7f7f7',
        muted: '#c7c7c7',
        brand: '#f0c43c',
        warn: '#fbbf24',
        info: '#60a5fa',
        ok: '#4ade80',
      },
    },
    options: [
      {
        id: 'signal',
        type: 'select',
        label: { 'zh-CN': '信号强调色', 'en-US': 'Signal color' },
        description: {
          'zh-CN': '用于主按钮、选中高亮与焦点强调。',
          'en-US': 'Applies to primary buttons and selected highlights.',
        },
        default: 'amber',
        choices: [
          { value: 'amber', label: { 'zh-CN': '警示琥珀', 'en-US': 'Amber' }, swatch: '#f2c744' },
          { value: 'mint', label: { 'zh-CN': '手术薄荷', 'en-US': 'Mint' }, swatch: '#6ee7b7' },
          { value: 'sky', label: { 'zh-CN': '晴空蓝', 'en-US': 'Sky' }, swatch: '#7dd3fc' },
          { value: 'coral', label: { 'zh-CN': '暖珊瑚', 'en-US': 'Coral' }, swatch: '#fda4af' },
        ],
      },
      {
        id: 'frame',
        type: 'select',
        label: { 'zh-CN': '外框风格', 'en-US': 'Shell frame' },
        description: {
          'zh-CN': '浅色模式下应用外框色系；深色模式保持深墨。',
          'en-US': 'Controls outer app-shell frame in light mode.',
        },
        default: 'paper',
        choices: [
          { value: 'paper', label: { 'zh-CN': '暖纸', 'en-US': 'Paper' } },
          { value: 'ink', label: { 'zh-CN': '深墨', 'en-US': 'Ink' } },
          { value: 'signal', label: { 'zh-CN': '信号色', 'en-US': 'Signal' } },
        ],
      },
      {
        id: 'hard-shadow',
        type: 'toggle',
        label: { 'zh-CN': '硬投影', 'en-US': 'Offset hard shadow' },
        description: {
          'zh-CN': '为卡片和浮层启用实色硬偏移阴影。',
          'en-US': 'Adds crisp offset shadows to cards and popovers.',
        },
        default: true,
      },
    ],
    tokens: {
      light: {
        'app-shell': '#ece6d8',
        background: '#faf8f2',
        card: '#ffffff',
        popover: '#ffffff',
        sidebar: '#f5f1e6',
        secondary: '#efeadc',
        muted: '#f3efe4',
        accent: '#fae9a7',
        'accent-foreground': '#171614',
        foreground: '#171614',
        'card-foreground': '#171614',
        'popover-foreground': '#171614',
        'muted-foreground': '#4d4a42',
        border: '#24221e',
        input: '#24221e',
        primary: '#171614',
        'primary-foreground': '#ffffff',
        info: '#1d4ed8',
        brand: '#1d4ed8',
        ring: '#1d4ed8',
        radius: '0.25rem',
      },
      dark: {
        'app-shell': '#09090b',
        background: '#171717',
        card: '#202020',
        popover: '#262626',
        sidebar: '#141414',
        secondary: '#2d2d2d',
        muted: '#252525',
        accent: '#403718',
        'accent-foreground': '#f7f7f7',
        foreground: '#f7f7f7',
        'card-foreground': '#f7f7f7',
        'popover-foreground': '#f7f7f7',
        'muted-foreground': '#c7c7c7',
        border: '#c4c4c4',
        input: '#c4c4c4',
        primary: '#f2c744',
        'primary-foreground': '#171614',
        info: '#7db5ff',
        brand: '#7db5ff',
        ring: '#f2c744',
        radius: '0.25rem',
      },
    },
    extraCss: `
:root[data-theme="ink-editorial"] { --ink-signal: #f2c744; }
:root[data-theme="ink-editorial"][data-theme-option-signal="mint"] { --ink-signal: #6ee7b7; }
:root[data-theme="ink-editorial"][data-theme-option-signal="sky"] { --ink-signal: #7dd3fc; }
:root[data-theme="ink-editorial"][data-theme-option-signal="coral"] { --ink-signal: #fda4af; }
:root.theme-light[data-theme="ink-editorial"] { --accent: color-mix(in oklab, var(--ink-signal) 36%, #ffffff); }
:root.theme-light[data-theme="ink-editorial"][data-theme-option-frame="ink"] { --app-shell: #171614; }
:root.theme-light[data-theme="ink-editorial"][data-theme-option-frame="signal"] { --app-shell: var(--ink-signal); }
:root.theme-light[data-theme="ink-editorial"][data-theme-option-hard-shadow="on"] [data-slot="card"],
:root.theme-light[data-theme="ink-editorial"][data-theme-option-hard-shadow="on"] [data-cm="settings-card"] { box-shadow: 2px 2px 0 #1c1b18; }
:root.theme-dark[data-theme="ink-editorial"][data-theme-option-hard-shadow="on"] [data-slot="card"],
:root.theme-dark[data-theme="ink-editorial"][data-theme-option-hard-shadow="on"] [data-cm="settings-card"] { box-shadow: 2px 2px 0 var(--ink-signal); }
`,
  }),
]

export function findBuiltInTheme(id: string): BuiltInTheme | undefined {
  return BUILT_IN_THEMES.find(t => t.id === id)
}

export function isBuiltInThemeId(id: string): id is BuiltInThemeId {
  return BUILT_IN_THEMES.some(t => t.id === id)
}
