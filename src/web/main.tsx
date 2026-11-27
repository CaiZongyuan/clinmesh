import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createApprovalPrompt, createClinMeshUiAgent, mountClinMeshWebMCP, ThemeFontProvider, ToastProvider, UiAgentApprovalDialog } from '../packages/ui-kit';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

const catalog = window.location.pathname.replace(/\/$/, '') === '/dev/ui-kit';
const UiKitCatalog = lazy(() => import('./UiKitCatalog'));
const RuntimeHealth = lazy(() => import('./RuntimeHealth').then(module => ({ default: module.RuntimeHealth })));
const approval = createApprovalPrompt();
const agent = createClinMeshUiAgent(approval);
const unregister = mountClinMeshWebMCP(agent);
import.meta.hot?.dispose(unregister);
if (catalog) document.title = 'UI component catalogue · ClinMesh';

createRoot(root).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false }, mutations: { retry: false } } })}>
  <ThemeFontProvider><ToastProvider>
    <Suspense fallback={<p role="status">Loading…</p>}>{catalog ? <UiKitCatalog /> : window.location.pathname === '/dev/health' ? <RuntimeHealth /> : <App />}</Suspense>
    <UiAgentApprovalDialog prompt={approval} />
  </ToastProvider></ThemeFontProvider>
</QueryClientProvider>);
