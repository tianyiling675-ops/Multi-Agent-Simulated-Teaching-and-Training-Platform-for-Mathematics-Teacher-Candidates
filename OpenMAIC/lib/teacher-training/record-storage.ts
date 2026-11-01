import { createHash } from 'node:crypto';
import { emptyState, TrainingError, type TrainingState, type ClassroomEvent } from './contracts';
import { decodeState } from './store';

export interface StoredRecord {
  kind: string;
  record_id: string;
  body: string;
}
export const recordHeader = JSON.stringify({ ...emptyState(), recordStorage: 2 });
export function isRecordStorage(value: unknown) {
  return !!value && (typeof value === 'string' ? JSON.parse(value) : value).recordStorage === 2;
}
/** Individual immutable materials, event rows and content-addressed asset bytes.
 * Existing owner aggregates remain readable and migrate atomically on first write.
 * The owner lock still protects seq/revision/receipt updates together. */
export function encodeRecords(state: TrainingState): StoredRecord[] {
  const rows: StoredRecord[] = [];
  const assets = new Map<string, string>();
  const encode = (value: unknown) =>
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry !== 'string' || !entry.startsWith('data:') || entry.length < 1024)
        return entry;
      const digest = createHash('sha256').update(entry).digest('hex');
      assets.set(digest, entry);
      return { __trainingAsset: digest };
    });
  for (const [kind, values] of Object.entries(state)) {
    if (kind === 'schemaVersion' || kind === 'events') continue;
    for (const [record_id, body] of Object.entries(values ?? {}))
      rows.push({ kind, record_id, body: encode(body) });
  }
  for (const [sessionId, events] of Object.entries(state.events)) {
    // Empty sessions are represented by the session row itself.
    for (const event of events)
      rows.push({
        kind: 'events',
        record_id: sessionId + ':' + event.seq.toString().padStart(8, '0'),
        body: encode(event),
      });
  }
  for (const [record_id, value] of assets)
    rows.push({ kind: 'assets', record_id, body: JSON.stringify({ value }) });
  return rows;
}
export function decodeRecords(
  header: unknown,
  rows: { kind?: string; record_id?: string; body?: unknown }[],
): TrainingState {
  if (!isRecordStorage(header)) return decodeState(header);
  const state = emptyState();
  const assets = new Map<string, unknown>();
  const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
  for (const row of rows)
    if (row.kind === 'assets' && row.record_id) assets.set(row.record_id, parse(row.body).value);
  const restore = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restore);
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    if (typeof object.__trainingAsset === 'string') {
      if (!assets.has(object.__trainingAsset))
        throw new TrainingError('ASSET_MISSING', '材料资源缺失，请检查存储。', 503);
      return assets.get(object.__trainingAsset);
    }
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, restore(entry)]));
  };
  const target = state as unknown as Record<string, Record<string, unknown>>;
  for (const row of rows) {
    if (!row.kind || !row.record_id || row.kind === 'assets') continue;
    const value = restore(parse(row.body));
    if (row.kind === 'events') {
      const event = value as ClassroomEvent;
      (state.events[event.sessionId] ??= []).push(event);
    } else {
      target[row.kind] ??= {};
      target[row.kind][row.record_id] = value;
    }
  }
  for (const id of Object.keys(state.sessions)) {
    state.events[id] ??= [];
    state.events[id].sort((a, b) => a.seq - b.seq);
  }
  return state;
}
