import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import type { WorkspaceView } from '../../../packages/clinical-core';
import { api, ApiError, jsonBody, scopeKey } from '../../workbench-api';

const requestSchema = z.strictObject({ name: z.string(), version: z.int().nonnegative(), fields: z.record(z.string(), z.json()), key: z.uuid() });
type CashierRequest = z.infer<typeof requestSchema>;
export type CashierAction = (name: string, fields?: Record<string, z.core.util.JSONType>) => Promise<Record<string, z.core.util.JSONType>>;

export function useCashier(workspace: WorkspaceView, encounterId: string, version: number) {
  const cache = useQueryClient();
  const storageKey = ['clinmesh.cashier.v1', workspace.workspaceId, workspace.epoch, workspace.roleId, encounterId].join(':');
  const [saved, setSaved] = useState<CashierRequest | null>(() => {
    try { return requestSchema.safeParse(JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')).data ?? null; }
    catch { return null; }
  });
  const clear = () => { sessionStorage.removeItem(storageKey); setSaved(null); };
  const refresh = () => cache.invalidateQueries({ queryKey: scopeKey(workspace, 'cashier', workspace.roleId, encounterId) });
  const mutation = useMutation({ mutationFn: async (request: CashierRequest) => {
    const operation = workspace.operations.find(item => item.name === request.name && item.method === 'POST');
    if (!operation || !/^\/api\/his\/encounters\/:id\/(billing|payer)\//.test(operation.path)) throw Error('ROLE_FORBIDDEN');
    sessionStorage.setItem(storageKey, JSON.stringify(request));
    setSaved(request);
    return api(operation.path.replace(':id', encounterId), z.record(z.string(), z.json()), jsonBody(operation.method, { ...request.fields, epoch: workspace.epoch, expectedVersion: request.version, idempotencyKey: request.key }));
  }, onSuccess: async () => { clear(); await refresh(); }, onError: async error => { if (error instanceof ApiError && error.status < 500) clear(); await refresh(); } });
  const act: CashierAction = async (name, fields = {}) => {
    if (saved) throw Error('PENDING_COMMAND');
    return mutation.mutateAsync({ name, fields, version, key: crypto.randomUUID() });
  };
  return { act, error: mutation.error, busy: mutation.isPending, saved, retry: () => saved && mutation.mutate(saved) };
}
