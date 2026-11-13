import type { Slide } from '@openmaic/dsl';
import type { ClassroomEvent, SessionDetail } from './contracts';
import { blankSlide } from './slides';

export const classroomEventLabels: Record<string, string> = {
  start: '开始课堂',
  pause: '暂停课堂',
  resume: '继续课堂',
  recover: '恢复至暂停',
  interrupt: '收回发言权',
  call_on: '教师点名',
  end: '结束课堂',
  teacher_text: '教师发言',
  student_speech: '学生回答',
  voice_interrupted: '学生语音被打断',
  page_exposure: '展示课件',
  board_operation: '更新板书',
  board_visibility: '切换白板',
};
export function classroomSeconds(events: ClassroomEvent[], now: number) {
  let total = 0;
  let started: number | undefined;
  for (const event of events) {
    const at = Date.parse(event.receivedAt);
    if (!Number.isFinite(at)) continue;
    if (event.type === 'start' || event.type === 'resume') started ??= at;
    if (['pause', 'recover', 'end'].includes(event.type) && started !== undefined) {
      total += Math.max(0, at - started);
      started = undefined;
    }
  }
  return Math.max(0, Math.floor((total + (started === undefined ? 0 : now - started)) / 1000));
}
export const formatDuration = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export interface EvidenceRow {
  id: string;
  seq: number;
  lastSeq: number;
  eventIds: string[];
  type: string;
  title: string;
  text: string;
  studentId?: string;
  turnId?: string;
  intent?: 'explain' | 'question' | 'check';
  at: string;
  seconds: number;
  pageId: string | null;
  voice?: ClassroomEvent['payload']['voice'];
  rehearsalSeed?: true;
}

/** Pure, read-only evidence projection. Preserve all original event IDs for traceability. */
export function reviewEvidence(detail: Pick<SessionDetail, 'session' | 'events'>): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  let pageId: string | null = null;
  const events = [...detail.events].sort((a, b) => a.seq - b.seq);
  const start = Date.parse(
    events.find((e) => e.type === 'start')?.receivedAt ?? detail.session.createdAt,
  );
  for (const event of events) {
    if (event.type === 'page_exposure') pageId = event.payload.pageId ?? null;
    const previous = rows.at(-1);
    if (
      event.type === 'student_speech' &&
      event.payload.turnId &&
      previous?.type === 'student_speech' &&
      previous.turnId === event.payload.turnId &&
      previous.studentId === event.payload.studentId
    ) {
      previous.text += event.payload.text ?? '';
      previous.eventIds.push(event.id);
      previous.lastSeq = event.seq;
      continue;
    }
    rows.push({
      id: event.id,
      seq: event.seq,
      lastSeq: event.seq,
      eventIds: [event.id],
      type: event.type,
      title: classroomEventLabels[event.type] ?? '课堂操作',
      text: event.payload.text ?? '',
      studentId: event.payload.studentId,
      turnId: event.payload.turnId,
      intent: event.payload.intent,
      at: event.receivedAt,
      seconds: Math.max(
        0,
        Math.floor(
          (Date.parse(
            event.payload.voice?.startedAt ?? event.payload.voice?.endedAt ?? event.receivedAt,
          ) -
            start) /
            1000,
        ),
      ),
      pageId,
      ...(event.payload.rehearsalSeed ? { rehearsalSeed: true } : {}),
      ...(event.payload.voice ? { voice: event.payload.voice } : {}),
    });
  }
  return rows;
}

export function reviewStatistics(detail: SessionDetail) {
  const events = detail.events;
  return {
    seconds: classroomSeconds(
      events,
      Date.parse(detail.session.endedAt ?? events.at(-1)?.receivedAt ?? detail.session.createdAt),
    ),
    questions: events.filter((e) => e.type === 'teacher_text' && e.payload.intent === 'question')
      .length,
    checks: events.filter((e) => e.type === 'teacher_text' && e.payload.intent === 'check').length,
    answers: reviewEvidence(detail).filter(
      (row) => row.type === 'student_speech' && !row.rehearsalSeed,
    ).length,
  };
}

/** Reconstruct the frozen classroom up to a selected event, never from today's runtime. */
export function evidenceScene(detail: Pick<SessionDetail, 'material' | 'events'>, cutoff: number) {
  let board: Slide = blankSlide('evidence-board');
  let pageId: string | null = null;
  let boardOpen = false;
  for (const event of [...detail.events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq > cutoff) break;
    if (event.type === 'page_exposure') {
      pageId = event.payload.pageId ?? null;
      boardOpen = false;
    }
    if (event.type === 'board_visibility') boardOpen = !!event.payload.open;
    if (event.type === 'board_operation' && event.payload.operation) {
      const operation = event.payload.operation;
      board = {
        ...board,
        elements:
          operation.kind === 'clear'
            ? []
            : operation.kind === 'remove'
              ? board.elements.filter((element) => element.id !== operation.elementId)
              : [...board.elements, structuredClone(operation.element)],
      };
    }
  }
  return {
    board,
    boardOpen,
    page: detail.material.content.pages?.find((page) => page.id === pageId) ?? null,
  };
}
