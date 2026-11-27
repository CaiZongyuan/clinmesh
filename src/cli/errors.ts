type ErrorType = 'input' | 'configuration' | 'authorization' | 'server' | 'transport' | 'protocol';
type Recovery = { operation: 'command.receipt.get'; input: { epoch: string; idempotencyKey: string } };

export class CliError extends Error {
  constructor(readonly type: ErrorType, readonly code: string, message: string, readonly recovery?: Recovery) { super(message); }
  envelope() {
    return { ok: false, type: this.type, code: this.code, outcome: this.recovery ? 'ambiguous_outcome' : 'not_applied', message: this.message, recovery: this.recovery };
  }
}

export function invalid(message: string): never { throw new CliError('input', 'INVALID_INPUT', message); }
