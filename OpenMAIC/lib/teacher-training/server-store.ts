import { resolve } from 'node:path';
import type { TrainingStore } from './store';
import { TrainingError } from './contracts';

const KEY = Symbol.for('openmaic.teacher-training.store.records-v2');
const globalStores = globalThis as typeof globalThis & {
  [KEY]?: Map<string, Promise<TrainingStore>>;
};

export function trainingStorageMode() {
  return process.env.DATABASE_URL?.trim() ? 'postgres' : 'local';
}

export async function getTrainingStore(): Promise<TrainingStore> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (
    !connectionString &&
    process.env.NODE_ENV === 'production' &&
    process.env.TEACHER_TRAINING_ALLOW_LOCAL !== '1'
  ) {
    throw new TrainingError(
      'STORAGE_NOT_CONFIGURED',
      '请配置训练存储；本机演示可显式启用本地存储。',
      503,
    );
  }
  const path = resolve(process.env.TEACHER_TRAINING_SQLITE_PATH || 'data/teacher-training.sqlite');
  const key = connectionString ? `pg:${connectionString}` : `sqlite:${path}`;
  const stores = (globalStores[KEY] ??= new Map());
  let pending = stores.get(key);
  if (!pending) {
    pending = (async () => {
      if (!connectionString) {
        const { SqliteTrainingStore } = await import('./sqlite-store');
        return new SqliteTrainingStore(path);
      }
      const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
      const { PgTrainingStore, ensureTrainingSchema } = await import('./pg-store');
      const { pool } = await getServerPersistenceProvider(connectionString);
      await ensureTrainingSchema(pool);
      return new PgTrainingStore(pool, async (work) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      });
    })().catch((error) => {
      stores.delete(key);
      throw error;
    });
    stores.set(key, pending);
  }
  return pending;
}
