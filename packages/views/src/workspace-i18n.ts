const zhCN = {
  appName: 'ClinMesh',
  hospitalName: '安康市临床仿真医院',
  simulationBadge: '合成演示',
  navigationLabel: '岗位导航',
  navigationGroup: '岗位工作台',
  overview: '工作台总览',
  registration: '门诊挂号',
  triage: '分诊护理',
  consultation: '门诊诊疗',
  billing: '门诊收费',
  pharmacy: '门诊药房',
  workspaceEntries: '工作台入口',
  openWorkspace: '进入',
  searchLabel: '搜索工作台',
  searchPlaceholder: '搜索岗位或工作台',
  noSearchResults: '无匹配结果',
  sidebarToggle: '切换导航栏',
  mobileNavigationDescription: '显示移动端岗位导航。',
  notifications: '通知',
  notificationsTitle: '待办通知',
  noNotifications: '当前无待处理通知',
  userMenu: '用户菜单',
  demoUser: '演示用户',
  localWorkspace: '本地工作区',
  appearanceLabel: '外观',
  languageLabel: '语言',
  chinese: '中文',
  english: 'English',
  themeLabel: '主题',
  themeSystem: '跟随系统',
  themeLight: '亮色',
  themeDark: '暗色',
} as const

export type WorkspaceMessageKey = keyof typeof zhCN
export type WorkspaceMessages = { [Key in WorkspaceMessageKey]: string }
export type WorkspaceLocale = 'zh-CN' | 'en-US'

const enUS = {
  appName: 'ClinMesh',
  hospitalName: 'Ankang Clinical Simulation Hospital',
  simulationBadge: 'Synthetic demo',
  navigationLabel: 'Role navigation',
  navigationGroup: 'Role workspaces',
  overview: 'Workspace overview',
  registration: 'Registration',
  triage: 'Triage',
  consultation: 'Consultation',
  billing: 'Billing',
  pharmacy: 'Pharmacy',
  workspaceEntries: 'Workspace entries',
  openWorkspace: 'Open',
  searchLabel: 'Search workspaces',
  searchPlaceholder: 'Search workspaces',
  noSearchResults: 'No matching results',
  sidebarToggle: 'Toggle navigation',
  mobileNavigationDescription: 'Displays the mobile role navigation.',
  notifications: 'Notifications',
  notificationsTitle: 'Pending notifications',
  noNotifications: 'No pending notifications',
  userMenu: 'User menu',
  demoUser: 'Demo user',
  localWorkspace: 'Local workspace',
  appearanceLabel: 'Appearance',
  languageLabel: 'Language',
  chinese: '中文',
  english: 'English',
  themeLabel: 'Theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
} satisfies WorkspaceMessages

const catalogs: Record<WorkspaceLocale, WorkspaceMessages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

export function getWorkspaceMessages(locale: WorkspaceLocale): WorkspaceMessages {
  return catalogs[locale]
}
