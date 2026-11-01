import { emptyState, TrainingError, type TrainingState } from './contracts';

/** Mutators are synchronous and pure apart from modifying their supplied snapshot.
 * A backend must serialize a whole owner's mutation and commit it atomically.
 * No model, network or asset work may be performed while holding this transaction.
 */
export interface TrainingStore {
  read(ownerId: string): Promise<TrainingState>;
  update<T>(ownerId: string, mutation: (state: TrainingState) => T): Promise<T>;
}

export function decodeState(value: unknown): TrainingState {
  if (value == null) return emptyState();
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed.schemaVersion !== 1 || !parsed.projects || !parsed.receipts) {
    throw new TrainingError(
      'STORAGE_SCHEMA_UNSUPPORTED',
      '训练记录版本不兼容，请先迁移数据。',
      503,
    );
  }
  return parsed as TrainingState;
}
