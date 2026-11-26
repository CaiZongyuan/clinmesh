type DataPackErrorCode = 'INVALID_PACK' | 'INVALID_REFERENCE' | 'DUPLICATE_KEY' | 'PERSONA_TRUTH_LEAK' | 'EPOCH_CONFLICT';

export class DataPackError extends Error {
  constructor(readonly code: DataPackErrorCode, path: string) {
    super(`${code} (${path})`);
    this.name = 'DataPackError';
  }
}
