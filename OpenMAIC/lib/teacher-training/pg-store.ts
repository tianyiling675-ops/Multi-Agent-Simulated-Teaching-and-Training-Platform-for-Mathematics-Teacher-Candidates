import { emptyState, type TrainingState } from './contracts';
import type { TrainingStore } from './store';
import { encodeRecords, decodeRecords, isRecordStorage, recordHeader } from './record-storage';

export interface TrainingQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{
    rows: { body?: unknown; owner_body?: unknown; kind?: string; record_id?: string }[];
  }>;
}
export type TrainingTransaction = <T>(
  body: (queryable: TrainingQueryable) => Promise<T>,
) => Promise<T>;

export async function ensureTrainingSchema(db: TrainingQueryable) {
  await db.query(`CREATE TABLE IF NOT EXISTS teacher_training_owners (
    owner_id TEXT PRIMARY KEY, body JSONB NOT NULL
  )`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS teacher_training_records (owner_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, body JSONB NOT NULL, PRIMARY KEY(owner_id,kind,record_id))`,
  );
}

/** Record writes and migrations share the existing per-owner transaction lock. */
export class PgTrainingStore implements TrainingStore {
  constructor(
    private db: TrainingQueryable,
    private transaction: TrainingTransaction,
  ) {}
  private async snapshot(db: TrainingQueryable, ownerId: string) {
    const result = await db.query(
      'SELECT o.body AS owner_body, r.kind, r.record_id, r.body FROM teacher_training_owners o LEFT JOIN teacher_training_records r ON r.owner_id=o.owner_id WHERE o.owner_id=$1',
      [ownerId],
    );
    return { header: result.rows[0]?.owner_body, rows: result.rows };
  }
  async read(ownerId: string) {
    const { header, rows } = await this.snapshot(this.db, ownerId);
    return decodeRecords(header, rows);
  }
  async update<T>(ownerId: string, mutation: (state: TrainingState) => T): Promise<T> {
    return this.transaction(async (db) => {
      await db.query(
        `INSERT INTO teacher_training_owners(owner_id, body) VALUES ($1, $2::jsonb)
        ON CONFLICT(owner_id) DO NOTHING`,
        [ownerId, JSON.stringify(emptyState())],
      );
      await db.query('SELECT body FROM teacher_training_owners WHERE owner_id=$1 FOR UPDATE', [
        ownerId,
      ]);
      const snapshot = await this.snapshot(db, ownerId);
      const state = decodeRecords(snapshot.header, snapshot.rows);
      const before = new Map(
        isRecordStorage(snapshot.header)
          ? encodeRecords(state).map((row) => [row.kind + ':' + row.record_id, row.body])
          : [],
      );
      const result = mutation(state);
      await db.query('UPDATE teacher_training_owners SET body=$2::jsonb WHERE owner_id=$1', [
        ownerId,
        recordHeader,
      ]);
      for (const row of encodeRecords(state))
        if (before.get(row.kind + ':' + row.record_id) !== row.body)
          await db.query(
            'INSERT INTO teacher_training_records(owner_id,kind,record_id,body) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT(owner_id,kind,record_id) DO UPDATE SET body=excluded.body',
            [ownerId, row.kind, row.record_id, row.body],
          );
      return structuredClone(result);
    });
  }
}
