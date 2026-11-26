import { useQuery } from '@tanstack/react-query';
import { parseRuntimeHealth } from '../packages/platform';
import { Button } from '../packages/ui-kit';
import logo from '../../assets/logo.webp';

export function App() {
  const health = useQuery({
    queryKey: ['runtime-health'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/health', { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseRuntimeHealth(await response.json());
    },
  });
  return <main className="mx-auto max-w-2xl px-6 py-16">
    <header className="flex items-center gap-3">
      <img src={logo} alt="" width="40" height="40" />
      <h1 className="text-3xl font-semibold">ClinMesh</h1>
    </header>
    <section aria-labelledby="runtime" className="mt-10">
      <h2 id="runtime" className="mb-4 text-xl font-semibold">Runtime health</h2>
      {health.isPending ? <p role="status">Checking health…</p>
        : health.isError ? <p role="alert">Health data unavailable.</p>
        : <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt>Runtime</dt><dd>{health.data.runtime}</dd>
          <dt>Loaded modules</dt><dd>{health.data.loadedModules.join(', ') || 'None'}</dd>
        </dl>}
    </section>
    <nav aria-label="Developer tools" className="mt-6"><Button render={<a href="/dev/ui-kit" />}>UI component catalogue</Button></nav>
  </main>;
}
