import { TrainingError, type SessionDetail } from './contracts';
import type { FaceWindow } from './face-evidence';
import { faceReviewClips, nextInteraction } from './face-review';
import { reviewEvidence } from './review-model';
import { TrainingService } from './service';
import type { TrainingStore } from './store';

type RehearsalKind = NonNullable<SessionDetail['session']['rehearsal']>['kind'];

function summarize(
  detail: SessionDetail,
  windows: FaceWindow[],
  kind: RehearsalKind,
  anchorId?: string,
) {
  const rows = reviewEvidence(detail);
  const index = rows.findIndex((row) =>
    anchorId
      ? row.id === anchorId
      : kind === 'response'
        ? row.rehearsalSeed
        : row.type === 'teacher_text' && (row.intent === 'question' || row.intent === 'check'),
  );
  if (index === -1) return null;
  const anchor = rows[index];
  const next = nextInteraction(rows, index, kind);
  const followUp =
    next?.type === (kind === 'response' ? 'teacher_text' : 'student_speech') ? next : undefined;
  const face = faceReviewClips(detail, rows, windows).find(
    (clip) => clip.anchor?.id === anchor.id && clip.kind === kind,
  );
  return {
    before: anchor.text,
    after: followUp?.text,
    observation: face?.evidence.usable ? face.evidence.actions : undefined,
    durationMs: face?.durationMs,
    timing: face?.timing,
  };
}

export type RehearsalComparison = {
  original: ReturnType<typeof summarize>;
  current: ReturnType<typeof summarize>;
};

export async function compareRehearsal(
  store: TrainingStore,
  owner: string,
  sessionId: string,
): Promise<RehearsalComparison> {
  const service = new TrainingService(store, owner);
  const current = await service.getSession(sessionId);
  const rehearsal = current.session.rehearsal;
  if (!rehearsal) throw new TrainingError('NOT_FOUND', '该轮次没有重练记录。', 404);
  const [original, originalFace, currentFace] = await Promise.all([
    service.getSession(rehearsal.sourceSessionId),
    store.readFaceEvidence(owner, rehearsal.sourceSessionId),
    store.readFaceEvidence(owner, sessionId),
  ]);
  return {
    original: summarize(original, originalFace.windows, rehearsal.kind, rehearsal.anchorEventId),
    current: summarize(current, currentFace.windows, rehearsal.kind),
  };
}
