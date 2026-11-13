import type { SessionDetail } from './contracts';
import { faceWindowMs, summarizeFaceWindows, type FaceWindow } from './face-evidence';
import type { EvidenceRow } from './review-model';

export type FaceReviewClip = {
  id: string;
  kind: 'waiting' | 'response' | 'observation';
  anchor?: EvidenceRow;
  followUp?: EvidenceRow;
  offsetMs: number;
  durationMs: number;
  evidence: ReturnType<typeof summarizeFaceWindows>;
  timing: 'publication' | 'estimated-playback' | 'capture';
};

export function nextInteraction(rows: EvidenceRow[], index: number, kind: 'waiting' | 'response') {
  const stops =
    kind === 'waiting'
      ? ['student_speech', 'voice_interrupted', 'teacher_text', 'pause', 'end', 'recover']
      : [
          'teacher_text',
          'student_speech',
          'voice_interrupted',
          'call_on',
          'pause',
          'end',
          'recover',
        ];
  for (let i = index + 1; i < rows.length; i++) {
    if (stops.includes(rows[i].type)) return rows[i];
  }
}

export function faceReviewClips(detail: SessionDetail, rows: EvidenceRow[], windows: FaceWindow[]) {
  if (!windows.length) return [];
  const events = new Map(detail.events.map((event) => [event.id, event]));
  const start = Date.parse(
    detail.events.find((event) => event.type === 'start')?.receivedAt ?? detail.session.createdAt,
  );
  const clips: FaceReviewClip[] = [];
  const add = (
    clip: Omit<FaceReviewClip, 'evidence' | 'offsetMs' | 'durationMs'>,
    from: number,
    to: number,
    matching: FaceWindow[],
  ) => {
    if (to <= from || !matching.length) return;
    clips.push({
      ...clip,
      offsetMs: Math.max(0, from - start),
      durationMs: to - from,
      evidence: summarizeFaceWindows(matching),
    });
  };
  const ordered = [...windows].sort((a, b) => a.startedAt - b.startedAt);
  const windowFor = (from: number, to: number) => {
    let low = 0;
    let high = ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ordered[middle].startedAt < from - faceWindowMs) low = middle + 1;
      else high = middle;
    }
    const matching: FaceWindow[] = [];
    for (let i = low; i < ordered.length && ordered[i].startedAt <= to; i++) {
      if (ordered[i].endedAt >= from) matching.push(ordered[i]);
    }
    return matching;
  };

  for (const [index, row] of rows.entries()) {
    const event = events.get(row.eventIds.at(-1)!);
    if (!event) continue;
    const from = Date.parse(event.payload.voice?.endedAt ?? event.receivedAt);
    if (row.type === 'teacher_text' && (row.intent === 'question' || row.intent === 'check')) {
      const answer = nextInteraction(rows, index, 'waiting');
      if (answer?.type !== 'student_speech') continue;
      const response = events.get(answer.eventIds[0])!;
      const to =
        Date.parse(response.payload.voice?.endedAt ?? response.receivedAt) -
        (response.payload.voice?.playedMs ?? 0);
      add(
        {
          id: `waiting-${row.id}`,
          kind: 'waiting',
          anchor: row,
          followUp: answer,
          timing: response.payload.voice?.playedMs ? 'estimated-playback' : 'publication',
        },
        from,
        to,
        windowFor(from, to),
      );
    } else if (row.type === 'student_speech') {
      const next = nextInteraction(rows, index, 'response');
      if (next?.type !== 'teacher_text') continue;
      const to = Date.parse(next.voice?.startedAt ?? next.at);
      add(
        {
          id: `response-${row.id}`,
          kind: 'response',
          anchor: row,
          followUp: next,
          timing:
            event.payload.voice?.endedAt && next.voice?.startedAt
              ? 'estimated-playback'
              : 'publication',
        },
        from,
        to,
        windowFor(from, to),
      );
    }
  }

  if (!clips.some((clip) => clip.evidence.usable)) {
    let fallback: FaceWindow | undefined;
    for (const w of ordered) {
      const observation = summarizeFaceWindows([w]);
      if (observation.usable) fallback ??= w;
      if (!observation.actions.length) continue;
      const anchor = rows.findLast((row) => Date.parse(row.at) <= w.startedAt);
      add({ id: w.id, kind: 'observation', anchor, timing: 'capture' }, w.startedAt, w.endedAt, [
        w,
      ]);
      if (clips.length >= 8) break;
    }
    if (fallback && !clips.some((clip) => clip.evidence.usable)) {
      const anchor = rows.findLast((row) => Date.parse(row.at) <= fallback!.startedAt);
      add(
        { id: fallback.id, kind: 'observation', anchor, timing: 'capture' },
        fallback.startedAt,
        fallback.endedAt,
        [fallback],
      );
    }
  }
  return clips;
}
