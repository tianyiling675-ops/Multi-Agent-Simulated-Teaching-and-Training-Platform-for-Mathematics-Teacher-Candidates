import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TrainingStore } from './store';
import {
  encodeRecords,
  decodeRecords,
  isRecordStorage,
  recordHeader,
  type StoredRecord,
} from './record-storage';
import type { TrainingState } from './contracts';
import { emptyFaceEvidence, type FaceEvidence } from './face-evidence';

// Node >=22.19 is already the app's engine contract. Keep native SQLite
// server-only and avoid adding a native npm dependency or browser import.
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: string[]): { body: string } | undefined;
    all(...params: string[]): (StoredRecord & { owner_body: string })[];
    run(...params: string[]): unknown;
  };
  close(): void;
}

export class SqliteTrainingStore implements TrainingStore {
  private db: SqliteDatabase;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    // Load the native builtin at runtime: Turbopack rewrites createRequire's
    // node:sqlite call into a failing CommonJS external on Windows.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
      DatabaseSync: new (filename: string) => SqliteDatabase;
    };
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS teacher_training_owners (owner_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS teacher_training_records (owner_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner_id,kind,record_id));
      CREATE TABLE IF NOT EXISTS teacher_training_face_evidence (owner_id TEXT NOT NULL, session_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner_id,session_id));`);
  }
  private faceEvidence(ownerId: string, sessionId: string): FaceEvidence {
    const row = this.db
      .prepare('SELECT body FROM teacher_training_face_evidence WHERE owner_id=? AND session_id=?')
      .get(ownerId, sessionId);
    return row ? JSON.parse(row.body) : emptyFaceEvidence();
  }
  async readFaceEvidence(ownerId: string, sessionId: string) {
    return this.faceEvidence(ownerId, sessionId);
  }
  async updateFaceEvidence(
    ownerId: string,
    sessionId: string,
    mutation: (evidence: FaceEvidence) => FaceEvidence,
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = mutation(this.faceEvidence(ownerId, sessionId));
      this.db
        .prepare(
          'INSERT INTO teacher_training_face_evidence(owner_id,session_id,body) VALUES (?,?,?) ON CONFLICT(owner_id,session_id) DO UPDATE SET body=excluded.body',
        )
        .run(ownerId, sessionId, JSON.stringify(next));
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private snapshot(ownerId: string) {
    const rows = this.db
      .prepare(
        'SELECT o.body AS owner_body, r.kind, r.record_id, r.body FROM teacher_training_owners o LEFT JOIN teacher_training_records r ON r.owner_id=o.owner_id WHERE o.owner_id=?',
      )
      .all(ownerId);
    return { header: rows[0]?.owner_body, rows };
  }
  async read(ownerId: string): Promise<TrainingState> {
    const { header, rows } = this.snapshot(ownerId);
    return decodeRecords(header, rows);
  }
  async update<T>(ownerId: string, mutation: (state: TrainingState) => T): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = this.snapshot(ownerId);
      const state = decodeRecords(snapshot.header, snapshot.rows);
      const before = new Map(
        isRecordStorage(snapshot.header)
          ? encodeRecords(state).map((row) => [row.kind + ':' + row.record_id, row.body])
          : [],
      );
      const result = mutation(state);
      this.db
        .prepare(
          'INSERT INTO teacher_training_owners(owner_id,body) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET body=excluded.body',
        )
        .run(ownerId, recordHeader);
      const upsert = this.db.prepare(
        'INSERT INTO teacher_training_records(owner_id,kind,record_id,body) VALUES (?,?,?,?) ON CONFLICT(owner_id,kind,record_id) DO UPDATE SET body=excluded.body',
      );
      for (const row of encodeRecords(state))
        if (before.get(row.kind + ':' + row.record_id) !== row.body)
          upsert.run(ownerId, row.kind, row.record_id, row.body);
      this.db.exec('COMMIT');
      return structuredClone(result);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
