// @vitest-environment jsdom
import '../../../../scripts/testing/ui-sdk-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { v7 } from 'uuid';
import { z } from 'zod';
import { accountSchema } from '../../../packages/mod-billing';
import { createClinMeshUiAgent } from '../../../packages/ui-kit';
import { CashierDesk } from './CashierDesk';

afterEach(cleanup);
it('lets an agent select charges and freeze a preview, keeping its final payment behind human approval', async () => {
  const ids = [v7(), v7()];
  const bill = accountSchema.parse({ encounterId: v7(), encounterClass: 'outpatient', admissionStatus: null, policy: 'postpaid', currency: { code: 'JPY', minorUnitExponent: 0 }, version: 2,
    charges: ids.map((id, index) => ({ id, orderId: v7(), catalogItemId: v7(), catalogVersion: '1', description: ['ECG', 'Blood test'][index], department: null, businessDay: '2026-11-26', quantity: 1, unitPriceMinor: 300, amountMinor: 300, adjustedMinor: 0, netMinor: 300, coverageMinor: 0, payerRevision: 0, payerPending: false, netPaidMinor: 0, refundedMinor: 0, outstandingMinor: 300, pending: false, cancelled: false, released: false, version: 1, adjustments: [] })),
    payments: [], netMinor: 600, coverageMinor: 0, cashMinor: 0, balanceMinor: 600, pending: false, payerPending: false, settlement: null });
  const commitToken = v7();
  const preview = { commitToken, version: 2, expiresAt: '2026-11-26T16:00:00Z', fingerprint: 'a'.repeat(64), kind: 'collection', originId: null, reason: '', tenders: [{ method: 'cash', amountMinor: 600 }], allocations: ids.map(chargeId => ({ chargeId, amountMinor: 300 })), amountMinor: 600 };
  const command = vi.fn(async (name: string) => z.record(z.string(), z.json()).parse(name === 'payment.preview' ? preview : { status: 'succeeded' }));
  const approve = vi.fn(async () => false);
  const agent = createClinMeshUiAgent({ requestApproval: approve });
  render(<CashierDesk bill={bill} language="en" busy={false} act={command}/>);
  const user = userEvent.setup();
  for (const label of ['ECG', 'Blood test']) {
    const choice = agent.snapshot().find(entry => entry.label?.startsWith(label))!;
    const result = await agent.act({ steps: [{ ref: choice.ref, action: 'setChecked', args: [true] }] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }
  await user.click(screen.getByRole('button', { name: 'Collect selected charges' }));
  await user.click(await screen.findByRole('button', { name: 'Freeze payment preview' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('payment.preview', { chargeIds: ids, simulation: 'approved' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  const confirmation = await screen.findByRole('button', { name: 'Confirm frozen preview' });
  expect(confirmation.getAttribute('data-agent-confirm')).toBeTruthy();
  const button = agent.snapshot().find(entry => entry.label === 'Confirm frozen preview')!;
  await agent.act({ steps: [{ ref: button.ref, action: 'press' }] });
  expect(approve).toHaveBeenCalledOnce();
  expect(command).toHaveBeenCalledTimes(1);
  await user.click(confirmation);
  expect(command).toHaveBeenLastCalledWith('payment.confirm', { commitToken });
});
