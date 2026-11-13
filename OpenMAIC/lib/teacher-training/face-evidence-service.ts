import { TrainingError, type ClassroomEvent } from './contracts';
import { faceModelVersion, faceUploadSchema, maxFaceWindows } from './face-evidence';
import { find } from './service';
import type { TrainingStore } from './store';

function runningIntervals(events: ClassroomEvent[], now: number) {
  const intervals: { start: number; end: number }[] = [];
  let start: number | undefined;
  for (const event of events) {
    const at = Date.parse(event.receivedAt);
    if (event.type === 'start' || event.type === 'resume') start ??= at;
    if (start !== undefined && ['pause', 'recover', 'end'].includes(event.type)) {
      intervals.push({ start, end: at });
      start = undefined;
    }
  }
  if (start !== undefined) intervals.push({ start, end: now });
  return intervals;
}

export class FaceEvidenceService {
  constructor(
    private store: TrainingStore,
    private owner: string,
  ) {}

  async read(sessionId: string, capture = false) {
    find((await this.store.read(this.owner)).sessions, sessionId);
    const evidence = await this.store.readFaceEvidence(this.owner, sessionId);
    return {
      ...evidence,
      windows: capture ? [] : evidence.windows,
      serverTime: Date.now(),
      modelVersion: faceModelVersion,
    };
  }

  async append(sessionId: string, input: unknown) {
    const body = faceUploadSchema.parse(input);
    const state = await this.store.read(this.owner);
    find(state.sessions, sessionId);
    const intervals = runningIntervals(state.events[sessionId], Date.now());
    // Allow small clock/network uncertainty when the client aligns to server time.
    if (
      body.windows.some(
        (w) =>
          !intervals.some(
            ({ start, end }) => w.startedAt >= start - 1_500 && w.endedAt <= end + 1_500,
          ),
      )
    )
      throw new TrainingError('FACE_WINDOW_OUTSIDE_SESSION', '表情摘要不在本轮授课时段内。', 409);
    await this.store.updateFaceEvidence(this.owner, sessionId, (previous) => {
      if (previous.generation !== body.generation)
        throw new TrainingError('FACE_EVIDENCE_RESET', '本轮表情证据已清除，请重新开启分析。', 409);
      const windows = new Map(previous.windows.map((w) => [w.id, w]));
      for (const window of body.windows) {
        const existing = windows.get(window.id);
        if (
          existing &&
          (Object.keys(window) as (keyof typeof window)[]).some(
            (key) => existing[key] !== window[key],
          )
        )
          throw new TrainingError('IDEMPOTENCY_CONFLICT', '表情摘要标识已用于其他记录。', 409);
        windows.set(window.id, window);
      }
      if (windows.size > maxFaceWindows)
        throw new TrainingError('LIMIT_REACHED', '本轮表情证据已达到存储上限。', 409);
      return {
        generation: previous.generation,
        modelVersion: body.modelVersion,
        windows: [...windows.values()],
      };
    });
    return { saved: true };
  }

  async clear(sessionId: string) {
    find((await this.store.read(this.owner)).sessions, sessionId);
    await this.store.updateFaceEvidence(this.owner, sessionId, (previous) => ({
      generation: previous.generation + 1,
      modelVersion: faceModelVersion,
      windows: [],
    }));
    return { cleared: true };
  }
}
