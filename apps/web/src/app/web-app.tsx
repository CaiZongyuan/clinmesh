import {
  type AppSection,
  isSettingsSection,
  roleSections,
  settingsRoutes,
  WorkspaceShell,
  workspaceRoutes,
} from './workspace-shell.tsx'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
  useNavigate,
} from '@tanstack/react-router'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@clinmesh/ui/components/card'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Toaster } from '@clinmesh/ui/components/toast'
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { CircleAlertIcon, LogInIcon } from 'lucide-react'
import type { SessionContext } from '@clinmesh/contracts/his'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyResolvedWebTheme,
  readWebPreferences,
  writeWebPreferences,
} from './preferences.ts'
import {
  ApiClientError,
  getSession,
  selectRole,
  sessionQueryKey,
  signIn,
  signOut,
  configureApiBasePath,
} from './api-client.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'
import { RoleWorkspace } from './role-workspaces.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { ComponentCatalog } from './component-catalog.tsx'
import { SettingsWorkspace } from './settings-workspace.tsx'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import {
  useWebRuntime,
  WebRuntimeProvider,
  type WebRuntimeOptions,
} from './web-runtime.tsx'
import { AgentPageRegistryProvider } from './agent-page-context.tsx'
import { useSurfaceAgentPublisher } from './surface-agent-publisher.ts'
import { AgentReviewProvider } from './agent-review.tsx'
import clinmeshMarkUrl from '../assets/clinmesh-mark.webp'
import clinmeshWordmarkUrl from '../assets/clinmesh-wordmark.webp'
import { RuntimeErrorBoundary } from './runtime-error-boundary.tsx'

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'
const IS_DEVELOPMENT = process.env.NODE_ENV !== 'production'

function SurfaceAgentBinding({
  activeSection,
  navigate,
  session,
}: {
  activeSection: AppSection
  navigate: ReturnType<typeof useNavigate>
  session: SessionContext
}): null {
  useSurfaceAgentPublisher({
    activeSection,
    navigate,
    session,
  })
  return null
}

function WorkspacePage({ activeSection }: { activeSection: AppSection }): React.JSX.Element {
  const [preferences, setPreferences] = useState(readWebPreferences)
  const messages = getWorkspaceMessages(preferences.locale)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const runtime = useWebRuntime()
  const session = useQuery({
    queryFn: ({ signal }) => getSession(signal),
    queryKey: sessionQueryKey,
    retry: false,
  })
  const roleChange = useMutation({
    mutationFn: selectRole,
    onSuccess: async nextSession => {
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== sessionQueryKey[0],
      })
      queryClient.setQueryData(sessionQueryKey, nextSession)
      const nextSection = roleSections[nextSession.actor.roleCode]
      const nextRoute = workspaceRoutes.find(route => route.key === nextSection)
      await navigate({ replace: true, to: nextRoute?.path ?? '/' })
    },
  })
  const signOutRequest = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== sessionQueryKey[0],
      })
      await navigate({ replace: true, to: '/' })
      await session.refetch()
    },
  })
  const roleCode = session.data?.actor.roleCode

  useEffect(() => {
    if (roleCode === undefined) return
    if (isSettingsSection(activeSection)) return
    const roleSection = roleSections[roleCode]
    if (
      activeSection === roleSection
      || (roleCode === 'administrator' && (activeSection === 'overview' || activeSection === 'scenarioData'))
    ) return
    const roleRoute = workspaceRoutes.find(route => route.key === roleSection)
    void navigate({ replace: true, to: roleRoute?.path ?? '/' })
  }, [activeSection, navigate, roleCode])

  useEffect(() => {
    const root = runtime.mode === 'surface'
      ? runtime.appearanceRoot.current
      : document.documentElement
    if (root !== null) root.lang = preferences.locale
    writeWebPreferences(preferences)
  }, [preferences, runtime.appearanceRoot, runtime.mode])

  useEffect(() => {
    const root = runtime.mode === 'surface'
      ? runtime.appearanceRoot.current
      : document.documentElement
    if (root === null) return
    if (preferences.theme !== 'system') {
      applyResolvedWebTheme(preferences.theme, root)
      return
    }
    if (runtime.mode === 'surface' && runtime.surfaceColorScheme !== undefined) {
      applyResolvedWebTheme(runtime.surfaceColorScheme, root)
      return
    }

    const mediaQuery = window.matchMedia(DARK_MODE_QUERY)
    const applySystemTheme = (): void => applyResolvedWebTheme(
      mediaQuery.matches ? 'dark' : 'light',
      root,
    )

    applySystemTheme()
    mediaQuery.addEventListener('change', applySystemTheme)

    return () => mediaQuery.removeEventListener('change', applySystemTheme)
  }, [preferences.theme, runtime.appearanceRoot, runtime.mode, runtime.surfaceColorScheme])

  if (session.isPending) {
    return (
      <main aria-label={messages.loading} className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-3 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </main>
    )
  }

  if (session.error instanceof ApiClientError && session.error.status === 401) {
    return <SignInScreen locale={preferences.locale} />
  }

  if (session.isError) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-lg items-center p-6">
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(session.error, messages, messages.serviceError)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(session.error, messages)}</AlertDescription>
        </Alert>
      </main>
    )
  }

  const roleSection = roleSections[session.data.actor.roleCode]
  const effectiveSection = isSettingsSection(activeSection)
    ? activeSection
    : activeSection === roleSection
      || (session.data.actor.roleCode === 'administrator' && (
        activeSection === 'overview' || activeSection === 'scenarioData'
      ))
      ? activeSection
      : roleSection

  return (
    <WorkspaceShell
      activeSection={effectiveSection}
      locale={preferences.locale}
      onLocaleChange={locale => setPreferences(current => ({ ...current, locale }))}
      onRoleChange={practitionerRoleId => roleChange.mutate(practitionerRoleId)}
      onSignOut={() => signOutRequest.mutate()}
      onThemeChange={theme => setPreferences(current => ({ ...current, theme }))}
      roleChangePending={roleChange.isPending}
      session={session.data}
      signOutPending={signOutRequest.isPending}
      theme={preferences.theme}
    >
      <SurfaceAgentBinding
        activeSection={effectiveSection}
        navigate={navigate}
        session={session.data}
      />
      {roleChange.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(roleChange.error, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(roleChange.error, messages)}</AlertDescription>
        </Alert>
      ) : null}
      {signOutRequest.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(signOutRequest.error, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(signOutRequest.error, messages)}</AlertDescription>
        </Alert>
      ) : null}
      {isSettingsSection(effectiveSection) ? (
        <SettingsWorkspace
          activeSection={effectiveSection}
          locale={preferences.locale}
          onLocaleChange={locale => setPreferences(current => ({ ...current, locale }))}
          onThemeChange={theme => setPreferences(current => ({ ...current, theme }))}
          theme={preferences.theme}
        />
      ) : (
        <RoleWorkspace
          activeSection={effectiveSection}
          locale={preferences.locale}
          session={session.data}
        />
      )}
    </WorkspaceShell>
  )
}

function SignInScreen({ locale }: { locale: 'en-US' | 'zh-CN' }): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const mutation = useMutation({
    mutationFn: () => signIn(email, password),
    onSuccess: async () => {
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== sessionQueryKey[0],
      })
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey })
    },
  })

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-3 flex min-w-0 flex-col items-center gap-2 text-center">
            <div className="flex w-full items-center justify-center gap-3 bg-white px-3 py-2">
              <img alt={messages.logoAlt} className="size-14 shrink-0" src={clinmeshMarkUrl} />
              <img alt="Clinmesh" className="h-auto max-h-9 min-w-0 max-w-44" src={clinmeshWordmarkUrl} />
            </div>
            <div>
              <div className="text-sm font-semibold">{messages.appName}</div>
              <div className="text-xs text-muted-foreground">{messages.productTagline}</div>
            </div>
          </div>
          <CardTitle aria-level={1} role="heading">{messages.loginTitle}</CardTitle>
          <CardDescription>{messages.loginDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="clinmesh-sign-in"
            onSubmit={event => {
              event.preventDefault()
              mutation.mutate()
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="clinmesh-email">{messages.emailLabel}</FieldLabel>
                <Input
                  autoComplete="username"
                  id="clinmesh-email"
                  onChange={event => setEmail(event.currentTarget.value)}
                  required
                  type="email"
                  value={email}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="clinmesh-password">{messages.passwordLabel}</FieldLabel>
                <Input
                  autoComplete="current-password"
                  id="clinmesh-password"
                  onChange={event => setPassword(event.currentTarget.value)}
                  required
                  type="password"
                  value={password}
                />
              </Field>
              {mutation.isError ? (
                <Alert variant="destructive">
                  <CircleAlertIcon aria-hidden="true" />
                  <AlertTitle>{messages.authenticationError}</AlertTitle>
                  <AlertDescription>{getWorkspaceErrorMessage(mutation.error, messages)}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter>
          <Button className="ml-auto" disabled={mutation.isPending} form="clinmesh-sign-in" type="submit">
            <LogInIcon data-icon="inline-start" />
            {mutation.isPending ? messages.signingIn : messages.signIn}
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <WorkspacePage activeSection="overview" />,
})

const routes = workspaceRoutes.map(({ key, path }) => createRoute({
  component: () => <WorkspacePage activeSection={key} />,
  getParentRoute: () => rootRoute,
  path,
}))

const settingsRouteTree = settingsRoutes.map(({ key, path }) => createRoute({
  component: () => <WorkspacePage activeSection={key} />,
  getParentRoute: () => rootRoute,
  path,
}))

const componentCatalogRoute = createRoute({
  component: ComponentCatalog,
  getParentRoute: () => rootRoute,
  path: '/components',
})

const UiDevPage = IS_DEVELOPMENT
  ? lazy(async () => {
      const module = await import('../ui-dev/doctor-workspace-lab-page.tsx')
      return { default: module.DoctorWorkspaceLabPage }
    })
  : () => null

const DataGenerationLabPage = IS_DEVELOPMENT
  ? lazy(async () => {
      const module = await import('../ui-dev/data-generation-lab-page.tsx')
      return { default: module.DataGenerationLabPage }
    })
  : () => null

const BrandLockupLabPage = IS_DEVELOPMENT
  ? lazy(async () => {
      const module = await import('../ui-dev/brand-lockup-lab-page.tsx')
      return { default: module.BrandLockupLabPage }
    })
  : () => null

const developmentRoutes = IS_DEVELOPMENT
  ? [
      createRoute({
        component: () => (
          <Suspense fallback={<main aria-label="正在加载 UI Lab" className="min-h-svh bg-muted/30" />}>
            <UiDevPage />
          </Suspense>
        ),
        getParentRoute: () => rootRoute,
        path: '/ui-dev',
      }),
      createRoute({
        component: () => (
          <Suspense fallback={<main aria-label="正在加载合成患者库 UI Lab" className="min-h-svh bg-muted/30" />}>
            <DataGenerationLabPage />
          </Suspense>
        ),
        getParentRoute: () => rootRoute,
        path: '/ui-dev/data-generation',
      }),
      createRoute({
        component: () => (
          <Suspense fallback={<main aria-label="正在加载品牌 UI Lab" className="min-h-svh bg-muted/30" />}>
            <BrandLockupLabPage />
          </Suspense>
        ),
        getParentRoute: () => rootRoute,
        path: '/ui-dev/brand',
      }),
    ]
  : []
const routeTree = rootRoute.addChildren([
  ...routes,
  ...settingsRouteTree,
  componentCatalogRoute,
  ...developmentRoutes,
])

export function createWebRouter(history?: RouterHistory): ReturnType<typeof createRouter<typeof routeTree>> {
  return createRouter({ routeTree, ...(history === undefined ? {} : { history }) })
}

type WebRouter = ReturnType<typeof createWebRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: WebRouter
  }
}

export function createWebQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, retry: false },
      mutations: { retry: false },
    },
  })
}

interface WebAppProps {
  history?: RouterHistory
  runtime?: WebRuntimeOptions
}

function WebApplication({
  history,
  runtime: runtimeOptions = {},
}: WebAppProps = {}): React.JSX.Element {
  const [router] = useState(() => createWebRouter(history))
  const [queryClient] = useState(createWebQueryClient)
  const applicationRoot = useRef<HTMLDivElement>(null)
  const portalRoot = useRef<HTMLDivElement>(null)
  const [apiConfiguration] = useState(() => ({
    release: configureApiBasePath(runtimeOptions.apiBasePath ?? ''),
  }))
  useEffect(() => apiConfiguration.release, [apiConfiguration])
  const runtime = useMemo(() => ({
    appearanceRoot: applicationRoot,
    mode: runtimeOptions.mode ?? 'standalone',
    ...(runtimeOptions.onExit === undefined ? {} : { onExit: runtimeOptions.onExit }),
    ...(runtimeOptions.surfaceActive === undefined ? {} : { surfaceActive: runtimeOptions.surfaceActive }),
    ...(runtimeOptions.surfaceAgent === undefined ? {} : { surfaceAgent: runtimeOptions.surfaceAgent }),
    ...(runtimeOptions.surfaceAgentStatus === undefined
      ? {}
      : { surfaceAgentStatus: runtimeOptions.surfaceAgentStatus }),
    ...(runtimeOptions.surfaceColorScheme === undefined
      ? {}
      : { surfaceColorScheme: runtimeOptions.surfaceColorScheme }),
    ...(runtimeOptions.surfaceSessionId === undefined
      ? {}
      : { surfaceSessionId: runtimeOptions.surfaceSessionId }),
  }), [
    runtimeOptions.mode,
    runtimeOptions.onExit,
    runtimeOptions.surfaceActive,
    runtimeOptions.surfaceAgent,
    runtimeOptions.surfaceAgentStatus,
    runtimeOptions.surfaceColorScheme,
    runtimeOptions.surfaceSessionId,
  ])

  return (
    <WebRuntimeProvider value={runtime}>
      <PortalContainerProvider container={portalRoot}>
        <div
          className={runtime.mode === 'surface'
            ? 'clinmesh-web-root h-full min-h-0 overflow-hidden'
            : 'clinmesh-web-root'}
          data-clinmesh-app="web"
          ref={applicationRoot}
        >
          <QueryClientProvider client={queryClient}>
            <AgentPageRegistryProvider>
              <AgentReviewProvider>
                <Toaster>
                  <RouterProvider router={router} />
                </Toaster>
              </AgentReviewProvider>
            </AgentPageRegistryProvider>
          </QueryClientProvider>
          <div data-clinmesh-portal-root="" ref={portalRoot} />
        </div>
      </PortalContainerProvider>
    </WebRuntimeProvider>
  )
}

export function WebApp(props: WebAppProps = {}): React.JSX.Element {
  return <RuntimeErrorBoundary><WebApplication {...props} /></RuntimeErrorBoundary>
}

export type { WebRuntimeOptions } from './web-runtime.tsx'
