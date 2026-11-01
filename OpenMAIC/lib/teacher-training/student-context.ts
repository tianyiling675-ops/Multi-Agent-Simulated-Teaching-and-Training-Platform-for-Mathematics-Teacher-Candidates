import type { PPTElement, Slide } from '@openmaic/dsl';
import type { TrainingState, ClassroomEvent } from './contracts';
import type { StudentTurn } from './classroom-contracts';

function plain(value: string) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function visibleElement(element: PPTElement): Record<string, unknown> {
  // Deliberately project the visible fields instead of serializing scene JSON.
  const e = element as PPTElement & {
    content?: string;
    latex?: string;
    text?: { content?: string };
    data?: unknown;
    lines?: { content: string }[];
    alt?: string;
  };
  return {
    type: e.type,
    left: e.left,
    top: e.top,
    width: e.width,
    ...('height' in e ? { height: e.height } : {}),
    ...(e.type === 'text' ? { text: plain(e.content ?? '') } : {}),
    ...(e.type === 'latex' ? { formula: e.latex } : {}),
    ...(e.type === 'shape'
      ? {
          text: plain(e.text?.content ?? ''),
          shape: 'path' in e ? e.path : undefined,
          viewBox: e.viewBox,
        }
      : {}),
    ...(e.type === 'line' ? { start: e.start, end: e.end } : {}),
    ...(e.type === 'image'
      ? { description: '课堂展示的图片；只能依据实际提供的视觉输入判断，不能猜测细节。' }
      : {}),
    ...(e.type === 'table'
      ? { rows: e.data.map((row) => row.map((cell) => plain(cell.text))) }
      : {}),
    ...(e.type === 'chart'
      ? { labels: e.data.labels, legends: e.data.legends, series: e.data.series }
      : {}),
    ...(e.type === 'code' ? { lines: e.lines?.map((line) => line.content) } : {}),
  };
}
function boardAt(events: ClassroomEvent[], cutoff: number): PPTElement[] {
  let elements: PPTElement[] = [];
  for (const event of events) {
    if (event.seq > cutoff) break;
    const op = event.payload.operation;
    if (event.type !== 'board_operation' || !op) continue;
    if (op.kind === 'add') elements.push(op.element);
    else if (op.kind === 'clear') elements = [];
    else elements = elements.filter((e) => e.id !== op.elementId);
  }
  return elements;
}
export function studentVisibleContext(state: TrainingState, sessionId: string, turn: StudentTurn) {
  const session = state.sessions[sessionId];
  const material = state.materials[session.materialVersionId];
  const config = state.classes[session.classConfigVersionId];
  const events = state.events[sessionId].filter((e) => e.seq <= turn.cutoff);
  const exposed = new Set(
    events.filter((e) => e.type === 'page_exposure').map((e) => e.payload.pageId),
  );
  const visiblePages = (material.content.pages ?? []).filter((page) => exposed.has(page.id));
  const students = config.students.filter((s) => !turn.studentId || s.id === turn.studentId);
  const classroomEvents = events.filter((e) =>
    ['teacher_text', 'student_speech', 'page_exposure', 'board_operation', 'call_on'].includes(
      e.type,
    ),
  );
  return {
    visualAssets: visibleImages(visiblePages.map((p) => p.canvas)),
    cutoff: turn.cutoff,
    triggerId: turn.triggerId,
    respondingStudentId: turn.studentId ?? null,
    students: students.map((s) => ({
      ...s,
      concepts: state.classrooms?.[sessionId]?.studentStates[s.id] ?? [],
    })),
    pages: visiblePages.map((p) => ({
      id: p.id,
      title: p.title,
      elements: p.canvas.elements.map(visibleElement),
    })),
    board: boardAt(events, turn.cutoff).map(visibleElement),
    events: classroomEvents.map((e) => ({
      id: e.id,
      seq: e.seq,
      type: e.type,
      actor: e.actorType,
      text: e.payload.text,
      studentId: e.payload.studentId,
      pageId: e.payload.pageId,
      intent: e.payload.intent,
    })),
  };
}

export function visibleImages(slides: Slide[]): string[] {
  return slides
    .flatMap((slide) =>
      slide.elements.flatMap((e) =>
        e.type === 'image' && /^data:image\/(png|jpeg|webp);base64,/.test(e.src) ? [e.src] : [],
      ),
    )
    .slice(-6);
}
