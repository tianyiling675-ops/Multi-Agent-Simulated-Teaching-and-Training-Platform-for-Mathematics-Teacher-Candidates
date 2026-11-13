import { z } from 'zod';
import {
  pageSchema,
  boardOperationSchema,
  type BoardOperation,
  type ClassroomRun,
  type ClassroomView,
} from './classroom-contracts';
import type { PreparationJob } from './preparation-service';
import { documentConversionSchema } from './document-contracts';

export const SCHEMA_VERSION = 1 as const;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const shortText = z.string().trim().min(1).max(200);
const text = z.string().max(30_000);
const revision = z.number().int().nonnegative();
export const requestKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const materialSchema = z
  .object({
    objectives: text,
    priorKnowledge: text,
    keyPoints: text,
    process: text,
    exercises: text,
    notes: text,
    // Optional so existing frozen versions retain their original hash and shape.
    pages: z.array(pageSchema).max(80).optional(),
    segments: z
      .array(z.object({ id, title: shortText, goal: z.string().max(1000) }).strict())
      .max(40),
    sources: z
      .array(
        z
          .object({
            name: shortText,
            format: z.enum(['txt', 'md', 'pptx', 'pdf', 'docx']),
            originalText: z.string().max(100_000),
            originalData: z.string().max(12_000_000).optional(),
            // Optional additions keep old snapshots and their hashes intact.
            sourceHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            purpose: z.enum(['lesson_plan', 'reference', 'courseware']).optional(),
            conversion: documentConversionSchema.optional(),
            referenceText: z.string().max(100_000).optional(),
          })
          .strict(),
      )
      .max(5),
  })
  .strict()
  .refine(
    (value) => new Set(value.segments.map((s) => s.id)).size === value.segments.length,
    '教学环节标识不能重复',
  );
export type MaterialContent = z.infer<typeof materialSchema>;
/** Stable across JSONB and browser object key order, including unsaved drafts. */
export const serializeMaterial = (content: MaterialContent): string =>
  JSON.stringify(content, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
export const emptyMaterial = (): MaterialContent => ({
  objectives: '',
  priorKnowledge: '',
  keyPoints: '',
  process: '',
  exercises: '',
  notes: '',
  segments: [],
  sources: [],
});

export const projectSchema = z
  .object({
    title: shortText,
    grade: shortText,
    scope: z.string().trim().min(1).max(2000),
    clientRequestId: requestKey,
  })
  .strict();
export const draftSchema = z
  .object({ expectedRevision: revision, content: materialSchema })
  .strict();
export const confirmSchema = z.object({ expectedRevision: revision }).strict();
export const studentSchema = z
  .object({
    id,
    name: shortText,
    priorKnowledge: z.string().max(2000),
    expression: z.enum(['active', 'responsive', 'reserved']),
    misconceptions: z.array(z.string().trim().min(1).max(500)).max(10),
  })
  .strict();
export const classSchema = z
  .object({
    projectId: id,
    template: z.enum(['strong', 'mixed', 'support']),
    students: z.array(studentSchema).min(1).max(8),
    clientRequestId: requestKey,
  })
  .strict()
  .refine(
    (value) => new Set(value.students.map((s) => s.id)).size === value.students.length,
    '学生标识不能重复',
  );
export const sessionSchema = z
  .object({
    projectId: id,
    materialVersionId: id,
    classConfigVersionId: id,
    // Further modes require their actual services and published rubrics before activation.
    inputMode: z.enum(['text', 'mixed']),
    assistance: z.literal('independent'),
    scope: z.literal('full'),
    plannedMinutes: z.number().int().min(1).max(180),
    clientRequestId: requestKey,
  })
  .strict();

export const rehearsalSchema = z
  .object({ anchorEventId: requestKey, clientRequestId: requestKey })
  .strict();
export const classDraftSchema = z
  .object({
    expectedRevision: revision,
    template: z.enum(['strong', 'mixed', 'support']),
    students: z.array(studentSchema).min(1).max(8),
    plannedMinutes: z.number().int().min(1).max(180),
    materialVersionId: id.nullable(),
  })
  .strict()
  .refine(
    (value) => new Set(value.students.map((s) => s.id)).size === value.students.length,
    '学生标识不能重复',
  );
export const commandSchema = z
  .object({
    command: z.enum(['start', 'pause', 'resume', 'recover', 'interrupt', 'call_on', 'end']),
    expectedRevision: revision,
    clientEventId: requestKey,
    studentId: id.optional(),
    voice: z.literal(true).optional(),
    confirmed: z.boolean().optional(),
  })
  .strict();
const eventBase = { expectedRevision: revision, clientEventId: requestKey };
export const eventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...eventBase,
      type: z.literal('teacher_text'),
      text: z.string().trim().min(1).max(10_000),
      intent: z.enum(['explain', 'question', 'check']).optional(),
      utteranceId: requestKey.optional(),
      input: z.enum(['text', 'asr']).optional(),
    })
    .strict(),
  z.object({ ...eventBase, type: z.literal('page_exposure'), pageId: id }).strict(),
  z.object({ ...eventBase, type: z.literal('board_visibility'), open: z.boolean() }).strict(),
  z
    .object({ ...eventBase, type: z.literal('board_operation'), operation: boardOperationSchema })
    .strict(),
]);

export type Student = z.infer<typeof studentSchema>;
export type SessionStatus = 'ready' | 'running' | 'paused' | 'interrupted' | 'ended';
export interface TrainingProject {
  id: string;
  title: string;
  grade: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}
export interface PreparationDraft {
  id: string;
  projectId: string;
  revision: number;
  content: MaterialContent;
  lastConfirmedRevision?: number;
  lastVersionId?: string;
}
export interface MaterialVersion {
  id: string;
  projectId: string;
  parentVersionId?: string;
  number: number;
  content: MaterialContent;
  contentHash: string;
  /** Absent only for the initial development snapshots using raw JSON order. */
  hashAlgorithm?: 'sha256-canonical-json-v1';
  sourceHashes: string[];
  createdAt: string;
  schemaVersion: 1;
}
export interface ClassConfigVersion {
  id: string;
  projectId: string;
  template: z.infer<typeof classSchema>['template'];
  students: Student[];
  createdAt: string;
  schemaVersion: 1;
}
export interface TrainingSession {
  id: string;
  projectId: string;
  materialVersionId: string;
  classConfigVersionId: string;
  trainingConfig: {
    inputMode: 'text' | 'mixed';
    assistance: 'independent';
    scope: 'full' | 'segment';
    plannedMinutes: number;
  };
  rubricVersionId: null;
  scoreStatus: 'pending_standard';
  totalScore: null;
  status: SessionStatus;
  revision: number;
  seq: number;
  speakerEpoch: number;
  createdAt: string;
  endedAt?: string;
  rehearsal?: {
    sourceSessionId: string;
    anchorEventId: string;
    cutoff: number;
    kind: 'waiting' | 'response';
    prompt: string;
    studentId?: string;
  };
  schemaVersion: 1;
}
/** Teacher-owned editable preparation, never returned as classroom public state. */
export interface ClassConfigDraft {
  id: string;
  projectId: string;
  revision: number;
  template: ClassConfigVersion['template'];
  students: Student[];
  plannedMinutes: number;
  materialVersionId: string | null;
}
export interface ClassroomEvent {
  id: string;
  sessionId: string;
  seq: number;
  type: string;
  clientEventId: string;
  actorType: 'teacher' | 'student';
  occurredAt: string;
  receivedAt: string;
  materialVersionId: string;
  payload: {
    text?: string;
    studentId?: string;
    from?: SessionStatus;
    to?: SessionStatus;
    pageId?: string;
    open?: boolean;
    operation?: BoardOperation;
    intent?: 'explain' | 'question' | 'check';
    input?: 'text' | 'asr';
    utteranceId?: string;
    turnId?: string;
    deliveredLength?: number;
    rehearsalSeed?: true;
    voice?: {
      callId: string;
      startedAt?: string;
      endedAt?: string;
      playedMs?: number;
    };
  };
  visibility: 'classroom';
  schemaVersion: 1;
}
export interface Receipt {
  fingerprint: string;
  result: unknown;
}
export interface TrainingState {
  schemaVersion: 1;
  projects: Record<string, TrainingProject>;
  drafts: Record<string, PreparationDraft>;
  materials: Record<string, MaterialVersion>;
  classes: Record<string, ClassConfigVersion>;
  sessions: Record<string, TrainingSession>;
  events: Record<string, ClassroomEvent[]>;
  receipts: Record<string, Receipt>;
  classrooms?: Record<string, ClassroomRun>;
  preparations?: Record<string, PreparationJob>;
  classDrafts?: Record<string, ClassConfigDraft>;
}
export const emptyState = (): TrainingState => ({
  schemaVersion: 1,
  projects: {},
  drafts: {},
  materials: {},
  classes: {},
  sessions: {},
  events: {},
  receipts: {},
});
export type PublicClassConfig = Omit<ClassConfigVersion, 'students'> & {
  students: Omit<Student, 'misconceptions'>[];
};
export interface ProjectDetail {
  project: TrainingProject;
  draft: PreparationDraft;
  materials: MaterialVersion[];
  classes: PublicClassConfig[];
  sessions: TrainingSession[];
  preparations?: PreparationJob[];
}
export interface SessionDetail {
  session: TrainingSession;
  material: MaterialVersion;
  classConfig: PublicClassConfig;
  events: ClassroomEvent[];
  classroom: ClassroomView;
}

export class TrainingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
