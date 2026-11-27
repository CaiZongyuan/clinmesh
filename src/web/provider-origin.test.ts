// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://teaching.example/" }
import { expect, it, vi } from 'vitest';
import { modelHeaders, saveModelSettings } from './model-preferences';

it('prevents either agent from constructing BYOK headers on an insecure public workbench', () => {
  const network = vi.spyOn(globalThis, 'fetch');
  try {
    saveModelSettings({ apiKey: 'synthetic-private-browser-key' });
    for (const role of ['patient', 'clinician'] as const) expect(() => modelHeaders(role)).toThrow('LLM_HTTPS_REQUIRED');
    expect(network).not.toHaveBeenCalled();
    saveModelSettings({ mock: true });
    expect(modelHeaders('patient')).toEqual({ 'X-ClinMesh-LLM-Mock': '1' });
  } finally { localStorage.clear(); network.mockRestore(); }
});
