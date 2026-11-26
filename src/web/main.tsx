import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createApprovalPrompt, createClinMeshUiAgent, ThemeFontProvider, ToastProvider, UiAgentApprovalDialog } from '../packages/ui-kit';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

const catalog = window.location.pathname.replace(/\/$/, '') === '/dev/ui-kit';
const UiKitCatalog = lazy(() => import('./UiKitCatalog'));
const approval = createApprovalPrompt();
const agent = createClinMeshUiAgent(approval);
const unregister = agent.registerWebMCP();
import.meta.hot?.dispose(unregister);
if (catalog) document.title = 'UI component catalogue · ClinMesh';

createRoot(root).render(<QueryClientProvider client={new QueryClient()}>
  <ThemeFontProvider><ToastProvider>
    {catalog ? <Suspense fallback={<p role="status">Loading the catalogue…</p>}><UiKitCatalog /></Suspense> : <App />}
    <UiAgentApprovalDialog prompt={approval} />
  </ToastProvider></ThemeFontProvider>
</QueryClientProvider>);
