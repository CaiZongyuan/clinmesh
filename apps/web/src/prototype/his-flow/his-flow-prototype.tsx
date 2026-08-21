import { Avatar, AvatarFallback } from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@clinmesh/ui/components/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@clinmesh/ui/components/sidebar'
import { Toaster, toast } from '@clinmesh/ui/components/toast'
import { TooltipProvider } from '@clinmesh/ui/components/tooltip'
import {
  ChevronDownIcon,
  CircleDollarSignIcon,
  ClipboardPlusIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  HeartPulseIcon,
  HospitalIcon,
  LogOutIcon,
  PillIcon,
  Settings2Icon,
  StethoscopeIcon,
  UserCogIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'

import { DoctorWorkstation } from './doctor-variants'
import {
  actors,
  createInitialScenario,
  formatVirtualTime,
  nextAssignments,
  screenFromUrl,
  screenTitles,
  variantFromUrl,
  type Actor,
  type DatasetKind,
  type FlowStep,
  type LisMode,
  type PrototypeScreen,
  type PrototypeVariant,
  type ScenarioState,
} from './model'
import {
  BillingPage,
  DataPackagePage,
  HospitalFlowPage,
  LisPage,
  LoginPage,
  PharmacyPage,
  RegistrationPage,
  RoleSelectionPage,
  SimulationPage,
  TriagePage,
} from './pages'
import { PrototypeSwitcher } from './prototype-switcher'
import { FlowRail, PatientBanner, ScenarioStatePanel } from './shared'

// Three doctor-workstation variants, switchable with ?variant=, on the throwaway /prototype/his-flow route.

interface NavItem {
  screen: PrototypeScreen
  icon: LucideIcon
  label: string
}

interface NavSection {
  label: string
  items: readonly NavItem[]
}

const navSections: readonly NavSection[] = [
  {
    label: '理解与身份',
    items: [
      { screen: 'flow', icon: WorkflowIcon, label: '全院流程' },
      { screen: 'roles', icon: UserCogIcon, label: '岗位选择' },
    ],
  },
  {
    label: '门诊工作台',
    items: [
      { screen: 'registration', icon: ClipboardPlusIcon, label: '挂号' },
      { screen: 'triage', icon: HeartPulseIcon, label: '分诊' },
      { screen: 'doctor', icon: StethoscopeIcon, label: '医生' },
      { screen: 'billing', icon: CircleDollarSignIcon, label: '收费' },
      { screen: 'lis', icon: FlaskConicalIcon, label: '模拟 LIS' },
      { screen: 'pharmacy', icon: PillIcon, label: '药房' },
    ],
  },
  {
    label: '仿真运行',
    items: [
      { screen: 'simulation', icon: Settings2Icon, label: '仿真控制' },
      { screen: 'data', icon: DatabaseIcon, label: '数据包' },
    ],
  },
] as const

interface PrototypeContentProps {
  actor: Actor
  scenario: ScenarioState
  screen: PrototypeScreen
  variant: PrototypeVariant
  onAdvance: (step: FlowStep, action: string, minutes?: number) => void
  onAdvanceTime: (minutes: number) => void
  onHandoff: () => void
  onImport: () => void
  onNavigate: (screen: PrototypeScreen) => void
  onReset: () => void
  onSelectActor: (actor: Actor, navigate?: boolean) => void
  onSetCheckpoint: (step: FlowStep, label: string) => void
  onSetDataset: (dataset: DatasetKind) => void
  onSetLisMode: (mode: LisMode) => void
  onSimulateConflict: () => void
  onSetScenario: React.Dispatch<React.SetStateAction<ScenarioState>>
}

export default function HisFlowPrototype(): React.JSX.Element {
  const initialScreen = screenFromUrl()
  const initialActor = actors.find((candidate) => candidate.screen === initialScreen) ?? actors[0]!
  const [authenticated, setAuthenticated] = useState(initialScreen !== 'login')
  const [screen, setScreen] = useState<PrototypeScreen>(initialScreen)
  const [variant, setVariant] = useState<PrototypeVariant>(variantFromUrl)
  const [actor, setActor] = useState<Actor>(initialActor)
  const [scenario, setScenario] = useState<ScenarioState>(createInitialScenario)
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  const updateUrl = (nextScreen: PrototypeScreen, nextVariant = variant) => {
    const url = new URL(window.location.href)
    url.searchParams.set('page', nextScreen)
    url.searchParams.set('variant', nextVariant)
    window.history.replaceState(null, '', url)
  }

  const navigate = (nextScreen: PrototypeScreen) => {
    setScreen(nextScreen)
    updateUrl(nextScreen)
    requestAnimationFrame(() => scrollViewportRef.current?.scrollTo({ top: 0 }))
  }

  const selectActor = (nextActor: Actor, shouldNavigate = false) => {
    setActor(nextActor)
    if (shouldNavigate) navigate(nextActor.screen)
    toast.add({ title: `已切换为${nextActor.role}`, description: `${nextActor.name} · ${nextActor.location}`, type: 'info' })
  }

  const advance = (step: FlowStep, action: string, minutes = 3) => {
    setScenario((current) => {
      const clockMinutes = current.clockMinutes + minutes
      return {
        ...current,
        clockMinutes,
        step,
        version: current.version + 1,
        lastConflict: null,
        events: [
          ...current.events,
          {
            id: (current.events.at(-1)?.id ?? 0) + 1,
            time: formatVirtualTime(clockMinutes).slice(-5),
            actor: `${actor.name} / ${actor.role}`,
            action,
          },
        ],
      }
    })
    toast.add({ title: '场景状态已推进', description: action, type: 'success' })
  }

  const handoff = () => {
    const assignment = nextAssignments[scenario.step]
    const nextActor = actors.find((candidate) => candidate.id === assignment.actorId)
    if (nextActor !== undefined) setActor(nextActor)
    navigate(assignment.screen)
    toast.add({ title: scenario.step === 'finished' ? '门诊闭环已完成' : `已交给${nextActor?.role ?? '下一岗位'}`, description: assignment.label, type: 'info' })
  }

  const mutateScenario = (action: string, mutation: (current: ScenarioState) => ScenarioState) => {
    setScenario((current) => {
      const next = mutation(current)
      return {
        ...next,
        version: current.version + 1,
        lastConflict: null,
        events: [
          ...next.events,
          {
            id: (next.events.at(-1)?.id ?? 0) + 1,
            time: formatVirtualTime(next.clockMinutes).slice(-5),
            actor: `${actor.name} / ${actor.role}`,
            action,
          },
        ],
      }
    })
  }

  const changeVariant = (nextVariant: PrototypeVariant) => {
    setVariant(nextVariant)
    setScreen('doctor')
    updateUrl('doctor', nextVariant)
  }

  return (
    <TooltipProvider>
      <Toaster>
        {authenticated ? (
          <SidebarProvider>
            <PrototypeSidebar
              actor={actor}
              currentScreen={screen}
              onNavigate={navigate}
            />
            <SidebarInset className="h-svh min-w-0 overflow-hidden">
              <PrototypeHeader
                actor={actor}
                scenario={scenario}
                screen={screen}
                onSelectActor={selectActor}
                onSignOut={() => {
                  setAuthenticated(false)
                  setScreen('login')
                  updateUrl('login')
                }}
              />
              <div ref={scrollViewportRef} className="min-h-0 flex-1 overflow-y-auto">
                <PatientBanner scenario={scenario} />
                <FlowRail scenario={scenario} onNavigate={navigate} />
                <div className="min-w-0 px-3 pt-4 pb-6 sm:px-4 lg:px-5">
                  <PrototypeContent
                    actor={actor}
                    scenario={scenario}
                    screen={screen}
                    variant={variant}
                    onAdvance={advance}
                    onAdvanceTime={(minutes) => mutateScenario(`虚拟时钟推进 ${minutes} 分钟`, (current) => ({ ...current, clockMinutes: current.clockMinutes + minutes }))}
                    onHandoff={handoff}
                    onImport={() => toast.add({ title: '原型未连接文件系统', description: '正式实现将验证来源 manifest、许可和内容哈希。', type: 'info' })}
                    onNavigate={navigate}
                    onReset={() => {
                      setScenario((current) => createInitialScenario(current.epoch + 1))
                      setActor(actors[0]!)
                      toast.add({ title: '已创建新 Epoch', description: '所有岗位已回到待挂号状态。', type: 'success' })
                    }}
                    onSelectActor={selectActor}
                    onSetCheckpoint={(step, label) => mutateScenario(label, (current) => ({ ...current, step }))}
                    onSetDataset={(dataset) => mutateScenario(`切换为 ${dataset} 数据集`, (current) => ({ ...current, dataset }))}
                    onSetLisMode={(lisMode) => mutateScenario(`LIS 脚本切换为 ${lisMode}`, (current) => ({ ...current, lisMode }))}
                    onSimulateConflict={() => {
                      setScenario((current) => {
                        const clockMinutes = current.clockMinutes + 1
                        const actualVersion = current.version + 1
                        const time = formatVirtualTime(clockMinutes).slice(-5)
                        return {
                          ...current,
                          clockMinutes,
                          version: actualVersion,
                          lastConflict: {
                            expectedVersion: current.version,
                            actualVersion,
                          },
                          events: [
                            ...current.events,
                            { id: (current.events.at(-1)?.id ?? 0) + 1, time, actor: '周芮 / 内科门诊医师', action: `远端写入成功，版本推进到 v${actualVersion}` },
                            { id: (current.events.at(-1)?.id ?? 0) + 2, time, actor: `${actor.name} / ${actor.role}`, action: `提交 expected v${current.version} 被拒绝并刷新` },
                          ],
                        }
                      })
                      toast.add({ title: '已阻止过期页面覆盖', description: '返回版本冲突并刷新到服务端最新状态。', type: 'warning' })
                    }}
                    onSetScenario={setScenario}
                  />
                  <ScenarioStatePanel actor={actor} scenario={scenario} />
                </div>
              </div>
              {import.meta.env.DEV && screen === 'doctor' ? <div aria-hidden="true" className="h-16 shrink-0" /> : null}
            </SidebarInset>
            {import.meta.env.DEV && screen === 'doctor' ? <PrototypeSwitcher current={variant} onChange={changeVariant} /> : null}
          </SidebarProvider>
        ) : (
          <LoginPage
            onLogin={() => {
              setAuthenticated(true)
              setScreen('roles')
              updateUrl('roles')
              toast.add({ title: '演示会话已建立', description: '请选择本次工作的岗位身份。', type: 'success' })
            }}
          />
        )}
      </Toaster>
    </TooltipProvider>
  )
}

function PrototypeContent({
  actor,
  scenario,
  screen,
  variant,
  onAdvance,
  onAdvanceTime,
  onHandoff,
  onImport,
  onNavigate,
  onReset,
  onSelectActor,
  onSetCheckpoint,
  onSetDataset,
  onSetLisMode,
  onSimulateConflict,
  onSetScenario,
}: PrototypeContentProps): React.JSX.Element {
  if (screen === 'roles') return <RoleSelectionPage actor={actor} onSelectActor={onSelectActor} />
  if (screen === 'flow') return <HospitalFlowPage scenario={scenario} onNavigate={onNavigate} onHandoff={onHandoff} />
  if (screen === 'registration') return <RegistrationPage actor={actor} scenario={scenario} onAdvance={onAdvance} onHandoff={onHandoff} />
  if (screen === 'triage') return <TriagePage actor={actor} scenario={scenario} onAdvance={onAdvance} onHandoff={onHandoff} onSetTriageLevel={(triageLevel) => onSetScenario((current) => ({ ...current, triageLevel }))} />
  if (screen === 'doctor') return <DoctorWorkstation actor={actor} scenario={scenario} variant={variant} onAdvance={onAdvance} onHandoff={onHandoff} />
  if (screen === 'billing') return <BillingPage actor={actor} scenario={scenario} onAdvance={onAdvance} onHandoff={onHandoff} />
  if (screen === 'lis') return <LisPage actor={actor} scenario={scenario} onAdvance={onAdvance} onHandoff={onHandoff} />
  if (screen === 'pharmacy') return <PharmacyPage actor={actor} scenario={scenario} onAdvance={onAdvance} onHandoff={onHandoff} />
  if (screen === 'simulation') return <SimulationPage scenario={scenario} onAdvanceTime={onAdvanceTime} onReset={onReset} onSetDataset={onSetDataset} onSetLisMode={onSetLisMode} onSetCheckpoint={onSetCheckpoint} onSimulateConflict={onSimulateConflict} />
  if (screen === 'data') return <DataPackagePage onImport={onImport} />
  return <HospitalFlowPage scenario={scenario} onNavigate={onNavigate} onHandoff={onHandoff} />
}

function PrototypeSidebar({
  actor,
  currentScreen,
  onNavigate,
}: {
  actor: Actor
  currentScreen: PrototypeScreen
  onNavigate: (screen: PrototypeScreen) => void
}): React.JSX.Element {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => onNavigate('flow')} size="lg" tooltip="ClinMesh 全院流程">
              <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground"><HospitalIcon /></div>
              <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">ClinMesh</span><span className="truncate text-xs">榆江市中心医院</span></div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        <PrototypeNavigation currentScreen={currentScreen} onNavigate={onNavigate} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => onNavigate('roles')} size="lg" tooltip={`${actor.name} · ${actor.role}`}>
              <Avatar className="size-8"><AvatarFallback>{actor.initials}</AvatarFallback></Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">{actor.name}</span><span className="truncate text-xs text-muted-foreground">{actor.role}</span></div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

function PrototypeNavigation({ currentScreen, onNavigate }: { currentScreen: PrototypeScreen; onNavigate: (screen: PrototypeScreen) => void }): React.JSX.Element {
  const { setOpenMobile } = useSidebar()
  return (
    <>
      {navSections.map((section) => (
        <SidebarGroup key={section.label}>
          <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <SidebarMenuItem key={item.screen}>
                    <SidebarMenuButton
                      isActive={currentScreen === item.screen}
                      onClick={() => {
                        onNavigate(item.screen)
                        setOpenMobile(false)
                      }}
                      tooltip={item.label}
                    >
                      <Icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  )
}

function PrototypeHeader({
  actor,
  scenario,
  screen,
  onSelectActor,
  onSignOut,
}: {
  actor: Actor
  scenario: ScenarioState
  screen: PrototypeScreen
  onSelectActor: (actor: Actor, navigate?: boolean) => void
  onSignOut: () => void
}): React.JSX.Element {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
      <SidebarTrigger aria-label="切换导航栏" title="切换导航栏" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{screenTitles[screen]}</p>
        <p className="hidden truncate text-xs text-muted-foreground sm:block">yujiang-general · {formatVirtualTime(scenario.clockMinutes)} · {actor.location}</p>
      </div>
      <Badge className="hidden sm:inline-flex" variant="outline">E-{scenario.epoch.toString().padStart(3, '0')}</Badge>
      <Badge className="hidden md:inline-flex" variant="warning">原型 · 合成数据</Badge>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
          <Avatar className="size-7"><AvatarFallback>{actor.initials}</AvatarFallback></Avatar>
          <span className="hidden max-w-28 truncate md:inline">{actor.role}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>切换演示操作者</DropdownMenuLabel>
            {actors.map((candidate) => (
              <DropdownMenuItem key={candidate.id} onClick={() => onSelectActor(candidate, true)}>
                <Avatar className="size-6"><AvatarFallback>{candidate.initials}</AvatarFallback></Avatar>
                <span className="min-w-0 flex-1"><span className="block truncate">{candidate.name}</span><span className="block truncate text-xs text-muted-foreground">{candidate.role}</span></span>
                {candidate.id === actor.id ? <Badge variant="success">当前</Badge> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onSignOut}><LogOutIcon />退出演示会话</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
