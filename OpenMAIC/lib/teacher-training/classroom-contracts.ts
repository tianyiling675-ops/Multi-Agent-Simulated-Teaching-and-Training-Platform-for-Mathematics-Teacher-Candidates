import { z } from 'zod';
import type { Slide, PPTElement } from '@openmaic/dsl';
import { blankSlide } from './slides';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
function validElement(value: unknown): value is PPTElement {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  const finite = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000;
  if (
    typeof e.id !== 'string' ||
    !id.safeParse(e.id).success ||
    !finite(e.left) ||
    !finite(e.top) ||
    !finite(e.width)
  )
    return false;
  if (e.type !== 'line' && (!finite(e.height) || !finite(e.rotate))) return false;
  switch (e.type) {
    case 'text':
      return typeof e.content === 'string';
    case 'image':
    case 'video':
    case 'audio':
      return typeof e.src === 'string';
    case 'latex':
      return typeof e.latex === 'string';
    case 'shape':
      return (
        typeof e.path === 'string' &&
        Array.isArray(e.viewBox) &&
        e.viewBox.length === 2 &&
        e.viewBox.every(finite)
      );
    case 'line':
      return [e.start, e.end].every((p) => Array.isArray(p) && p.length === 2 && p.every(finite));
    case 'chart':
      return !!e.data && typeof e.data === 'object' && typeof e.chartType === 'string';
    case 'table':
      return (
        Array.isArray(e.data) &&
        e.data.every((row) => Array.isArray(row)) &&
        Array.isArray(e.colWidths)
      );
    case 'code':
      return (
        Array.isArray(e.lines) && e.lines.every((line) => line && typeof line.content === 'string')
      );
    default:
      return false;
  }
}
export const slideSchema = z.custom<Slide>((value) => {
  if (!value || typeof value !== 'object') return false;
  const slide = value as Slide;
  return (
    typeof slide.id === 'string' &&
    slide.viewportSize > 0 &&
    slide.viewportSize <= 10_000 &&
    slide.viewportRatio >= 0.1 &&
    slide.viewportRatio <= 10 &&
    !!slide.theme &&
    Array.isArray(slide.theme.themeColors) &&
    typeof slide.theme.fontName === 'string' &&
    Array.isArray(slide.elements) &&
    slide.elements.length <= 500 &&
    slide.elements.every(validElement)
  );
}, '课件页面数据无效');
export const pageSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(200),
    canvas: slideSchema,
    source: z.enum(['uploaded', 'generated', 'edited']),
  })
  .strict();
export type TrainingPage = z.infer<typeof pageSchema>;

export const boardOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('add'), element: z.custom<PPTElement>(validElement, '板书元素无效') })
    .strict(),
  z.object({ kind: z.literal('remove'), elementId: id }).strict(),
  z.object({ kind: z.literal('clear') }).strict(),
]);
export type BoardOperation = z.infer<typeof boardOperationSchema>;
export interface StudentConceptState {
  concept: string;
  level: 'confused' | 'partial' | 'demonstrated';
  revision: number;
  evidenceIds: string[];
}
export const reactionSchema = z
  .object({
    hands: z.array(id).max(8),
    speech: z.string().max(1800),
    changes: z
      .array(
        z
          .object({
            concept: z.string().trim().min(1).max(200),
            oldRevision: z.number().int().nonnegative(),
            level: z.enum(['confused', 'partial', 'demonstrated']),
            evidenceIds: z.array(id).min(1).max(20),
            demonstratedBy: z.enum(['none', 'explanation', 'new_example', 'transfer_answer']),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type StudentReaction = z.infer<typeof reactionSchema>;
export interface StudentTurn {
  id: string;
  requestId: string;
  triggerId: string;
  studentId?: string;
  epoch: number;
  cutoff: number;
  status: 'generating' | 'proposed' | 'delivered' | 'cancelled' | 'failed';
  reaction?: StudentReaction;
  committedLength: number;
  createdAt: string;
}
export interface ClassroomRun {
  pageId: string | null;
  boardOpen: boolean;
  board: Slide;
  hands: string[];
  activeStudentId: string | null;
  studentStates: Record<string, StudentConceptState[]>;
  turns: Record<string, StudentTurn>;
}
export type ClassroomView = Pick<
  ClassroomRun,
  'pageId' | 'boardOpen' | 'board' | 'hands' | 'activeStudentId'
>;
export function emptyClassroom(): ClassroomRun {
  return {
    pageId: null,
    boardOpen: false,
    board: blankSlide('board'),
    hands: [],
    activeStudentId: null,
    studentStates: {},
    turns: {},
  };
}
export function publicClassroom(run: ClassroomRun): ClassroomView {
  return {
    pageId: run.pageId,
    boardOpen: run.boardOpen,
    board: run.board,
    hands: run.hands,
    activeStudentId: run.activeStudentId,
  };
}
