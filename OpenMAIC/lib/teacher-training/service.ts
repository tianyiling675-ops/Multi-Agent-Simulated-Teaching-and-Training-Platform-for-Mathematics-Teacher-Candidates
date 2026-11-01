import { createHash, randomUUID } from 'node:crypto';
import {
  classSchema,
  commandSchema,
  confirmSchema,
  draftSchema,
  emptyMaterial,
  eventSchema,
  projectSchema,
  sessionSchema,
  serializeMaterial,
  TrainingError,
  type ClassConfigVersion,
  type ClassroomEvent,
  type ProjectDetail,
  type SessionDetail,
  type TrainingSession,
  type TrainingState,
  type MaterialVersion,
  type MaterialContent,
} from './contracts';
import type { TrainingStore } from './store';
import { emptyClassroom, publicClassroom } from './classroom-contracts';
import { cleanMaterial, cleanSlide } from './materials';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// PostgreSQL JSONB reorders object keys. Content equality must not depend on
// transport/storage key order; array order remains significant.
const materialHash = (value: MaterialContent) =>
  createHash('sha256').update(serializeMaterial(value)).digest('hex');
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
const now = () => new Date().toISOString();
export function find<T>(values: Record<string, T>, id: string): T {
  if (!Object.prototype.hasOwnProperty.call(values, id)) {
    throw new TrainingError('NOT_FOUND', '记录不存在或不属于当前使用者。', 404);
  }
  return values[id];
}
export function expectRevision(actual: number, expected: number) {
  if (actual !== expected)
    throw new TrainingError(
      'VERSION_CONFLICT',
      '记录已有更新，请重新读取后核对；你的输入仍可保留。',
      409,
      { currentRevision: actual },
    );
}
export function once<T>(state: TrainingState, key: string, input: unknown, action: () => T): T {
  const fingerprint = hash(input);
  const previous = state.receipts[key];
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new TrainingError('IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同内容。', 409);
    return structuredClone(previous.result) as T;
  }
  const result = action();
  state.receipts[key] = { fingerprint, result: structuredClone(result) };
  return result;
}
function publicClass(config: ClassConfigVersion) {
  return {
    ...config,
    students: config.students.map(({ id, name, priorKnowledge, expression }) => ({
      id,
      name,
      priorKnowledge,
      expression,
    })),
  };
}
export function appendEvent(
  state: TrainingState,
  session: TrainingSession,
  clientEventId: string,
  type: string,
  payload: ClassroomEvent['payload'],
  actorType: ClassroomEvent['actorType'] = 'teacher',
): ClassroomEvent {
  const time = now();
  const event: ClassroomEvent = {
    id: newId('evt'),
    sessionId: session.id,
    seq: ++session.seq,
    type,
    clientEventId,
    actorType,
    occurredAt: time,
    receivedAt: time,
    materialVersionId: session.materialVersionId,
    payload,
    visibility: 'classroom',
    schemaVersion: 1,
  };
  state.events[session.id].push(event);
  session.revision++;
  return event;
}

export function classroomRun(state: TrainingState, sessionId: string) {
  state.classrooms ??= {};
  state.classrooms[sessionId] ??= emptyClassroom();
  return state.classrooms[sessionId];
}

export function cancelStudentTurns(state: TrainingState, session: TrainingSession) {
  const run = classroomRun(state, session.id);
  session.speakerEpoch++;
  run.activeStudentId = null;
  run.hands = [];
  for (const turn of Object.values(run.turns)) {
    if (turn.status === 'generating' || turn.status === 'proposed') turn.status = 'cancelled';
  }
}

export class TrainingService {
  constructor(
    private store: TrainingStore,
    private ownerId: string,
  ) {}

  async listProjects() {
    const state = await this.store.read(this.ownerId);
    return Object.values(state.projects)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((project) => ({
        ...project,
        versionCount: Object.values(state.materials).filter((v) => v.projectId === project.id)
          .length,
        sessionCount: Object.values(state.sessions).filter((s) => s.projectId === project.id)
          .length,
      }));
  }

  async createProject(input: unknown) {
    const body = projectSchema.parse(input);
    return this.store.update(this.ownerId, (state) =>
      once(state, `project:${body.clientRequestId}`, body, () => {
        if (Object.keys(state.projects).length >= 200)
          throw new TrainingError('LIMIT_REACHED', '当前工作区已达到 200 个课题的容量。', 409);
        const time = now();
        const project = {
          id: newId('project'),
          title: body.title,
          grade: body.grade,
          scope: body.scope,
          createdAt: time,
          updatedAt: time,
        };
        state.projects[project.id] = project;
        state.drafts[project.id] = {
          id: project.id,
          projectId: project.id,
          revision: 0,
          content: emptyMaterial(),
        };
        return project;
      }),
    );
  }

  async getProject(id: string): Promise<ProjectDetail> {
    const state = await this.store.read(this.ownerId);
    return {
      project: find(state.projects, id),
      draft: find(state.drafts, id),
      materials: Object.values(state.materials)
        .filter((v) => v.projectId === id)
        .sort((a, b) => b.number - a.number),
      classes: Object.values(state.classes)
        .filter((v) => v.projectId === id)
        .map(publicClass),
      sessions: Object.values(state.sessions)
        .filter((v) => v.projectId === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      preparations: Object.values(state.preparations ?? {}).filter((j) => j.projectId === id),
    };
  }

  async saveDraft(id: string, input: unknown) {
    const body = draftSchema.parse(input);
    body.content = cleanMaterial(body.content);
    return this.store.update(this.ownerId, (state) => {
      const draft = find(state.drafts, id);
      expectRevision(draft.revision, body.expectedRevision);
      if (materialHash(draft.content) !== materialHash(body.content)) {
        draft.content = structuredClone(body.content);
        draft.revision++;
        find(state.projects, id).updatedAt = now();
      }
      return draft;
    });
  }

  async confirmDraft(id: string, input: unknown) {
    const body = confirmSchema.parse(input);
    return this.store.update(this.ownerId, (state) => {
      const draft = find(state.drafts, id);
      expectRevision(draft.revision, body.expectedRevision);
      if (!draft.content.process.trim() && !draft.content.pages?.length)
        throw new TrainingError('MATERIAL_INCOMPLETE', '请准备教案或课件后，再确认材料版本。');
      if (draft.lastConfirmedRevision === draft.revision && draft.lastVersionId)
        return find(state.materials, draft.lastVersionId);
      const parent = draft.lastVersionId ? find(state.materials, draft.lastVersionId) : undefined;
      const version: MaterialVersion = {
        id: newId('material'),
        projectId: id,
        parentVersionId: parent?.id,
        number: (parent?.number ?? 0) + 1,
        content: structuredClone(draft.content),
        contentHash: materialHash(draft.content),
        hashAlgorithm: 'sha256-canonical-json-v1',
        sourceHashes: draft.content.sources.map((s) =>
          s.originalData
            ? createHash('sha256')
                .update(Buffer.from(s.originalData.split(',')[1] ?? '', 'base64'))
                .digest('hex')
            : hash(s.originalText),
        ),
        createdAt: now(),
        schemaVersion: 1,
      };
      state.materials[version.id] = version;
      draft.lastConfirmedRevision = draft.revision;
      draft.lastVersionId = version.id;
      return version;
    });
  }

  async createClass(input: unknown) {
    const body = classSchema.parse(input);
    return this.store.update(this.ownerId, (state) =>
      once(state, `class:${body.clientRequestId}`, body, () => {
        find(state.projects, body.projectId);
        const config: ClassConfigVersion = {
          id: newId('class'),
          projectId: body.projectId,
          template: body.template,
          students: structuredClone(body.students),
          createdAt: now(),
          schemaVersion: 1,
        };
        state.classes[config.id] = config;
        return publicClass(config);
      }),
    );
  }

  async createSession(input: unknown) {
    const body = sessionSchema.parse(input);
    return this.store.update(this.ownerId, (state) =>
      once(state, `session:${body.clientRequestId}`, body, () => {
        find(state.projects, body.projectId);
        const material = find(state.materials, body.materialVersionId);
        const config = find(state.classes, body.classConfigVersionId);
        if (material.projectId !== body.projectId || config.projectId !== body.projectId) {
          throw new TrainingError('VERSION_SCOPE_MISMATCH', '材料与班级必须属于当前课题。', 409);
        }
        const actualHash = material.hashAlgorithm
          ? materialHash(material.content)
          : hash(material.content);
        if (material.contentHash !== actualHash)
          throw new TrainingError('MATERIAL_CORRUPTED', '材料版本校验失败，请检查存储。', 409);
        const session: TrainingSession = {
          id: newId('training'),
          projectId: body.projectId,
          materialVersionId: material.id,
          classConfigVersionId: config.id,
          trainingConfig: {
            inputMode: body.inputMode,
            assistance: body.assistance,
            scope: body.scope,
            plannedMinutes: body.plannedMinutes,
          },
          rubricVersionId: null,
          scoreStatus: 'pending_standard',
          totalScore: null,
          status: 'ready',
          revision: 0,
          seq: 0,
          speakerEpoch: 0,
          createdAt: now(),
          schemaVersion: 1,
        };
        state.sessions[session.id] = session;
        state.events[session.id] = [];
        classroomRun(state, session.id);
        return session;
      }),
    );
  }

  async getSession(id: string): Promise<SessionDetail> {
    const state = await this.store.read(this.ownerId);
    const session = find(state.sessions, id);
    return {
      session,
      material: find(state.materials, session.materialVersionId),
      classConfig: publicClass(find(state.classes, session.classConfigVersionId)),
      events: find(state.events, id),
      classroom: publicClassroom(state.classrooms?.[id] ?? emptyClassroom()),
    };
  }

  async getRuntime(id: string) {
    const state = await this.store.read(this.ownerId);
    return {
      session: find(state.sessions, id),
      events: find(state.events, id),
      classroom: publicClassroom(state.classrooms?.[id] ?? emptyClassroom()),
    };
  }

  async command(id: string, input: unknown) {
    const body = commandSchema.parse(input);
    return this.store.update(this.ownerId, (state) => {
      const session = find(state.sessions, id);
      const receiptKey = `event:${id}:${body.clientEventId}`;
      const duplicate = Boolean(state.receipts[receiptKey]);
      const result = once(state, receiptKey, body, () => {
        expectRevision(session.revision, body.expectedRevision);
        const before = session.status;
        const allowed: Record<typeof body.command, TrainingSession['status'][]> = {
          start: ['ready'],
          pause: ['running'],
          resume: ['paused'],
          recover: ['running', 'interrupted'],
          interrupt: ['running'],
          call_on: ['running'],
          end: ['running', 'paused', 'interrupted'],
        };
        if (!allowed[body.command].includes(before))
          throw new TrainingError('SESSION_STATE_CONFLICT', '当前课堂状态不允许此操作。', 409);
        if (body.command === 'end' && body.confirmed !== true)
          throw new TrainingError('END_CONFIRMATION_REQUIRED', '请确认结束本轮课堂。');
        if (
          body.command === 'call_on' &&
          !find(state.classes, session.classConfigVersionId).students.some(
            (s) => s.id === body.studentId,
          )
        ) {
          throw new TrainingError('STUDENT_NOT_FOUND', '点名对象不属于本轮班级。');
        }
        if (body.command !== 'call_on' && body.studentId !== undefined)
          throw new TrainingError('INVALID_REQUEST', '此操作不接受学生标识。');
        if (body.command === 'start' || body.command === 'resume') session.status = 'running';
        if (body.command === 'pause' || body.command === 'recover') session.status = 'paused';
        if (body.command === 'end') {
          session.status = 'ended';
          session.endedAt = now();
        }
        cancelStudentTurns(state, session);
        const run = classroomRun(state, id);
        if (body.command === 'call_on') run.activeStudentId = body.studentId!;
        const event = appendEvent(state, session, body.clientEventId, body.command, {
          from: before,
          to: session.status,
          ...(body.studentId ? { studentId: body.studentId } : {}),
        });
        if (body.command === 'start') {
          const firstPage = find(state.materials, session.materialVersionId).content.pages?.[0];
          if (firstPage) {
            run.pageId = firstPage.id;
            appendEvent(state, session, `${body.clientEventId}-page`, 'page_exposure', {
              pageId: firstPage.id,
            });
          }
        }
        return { session, event, accepted: true };
      });
      return { ...result, duplicate };
    });
  }

  async submitEvent(id: string, input: unknown) {
    const body = eventSchema.parse(input);
    return this.store.update(this.ownerId, (state) => {
      const session = find(state.sessions, id);
      const receiptKey = `event:${id}:${body.clientEventId}`;
      const duplicate = Boolean(state.receipts[receiptKey]);
      const result = once(state, receiptKey, body, () => {
        expectRevision(session.revision, body.expectedRevision);
        if (session.status !== 'running')
          throw new TrainingError('SESSION_STATE_CONFLICT', '只有进行中的课堂可以提交发言。', 409);
        if (session.seq >= 5000)
          throw new TrainingError('LIMIT_REACHED', '本轮记录已达到容量，请结束并创建新轮次。', 409);
        const run = classroomRun(state, id);
        let payload: ClassroomEvent['payload'];
        if (body.type === 'teacher_text') {
          // A final ASR segment has one stable utterance identity even when retried.
          if (
            body.utteranceId &&
            state.events[id].some((e) => e.payload.utteranceId === body.utteranceId)
          )
            throw new TrainingError('UTTERANCE_ALREADY_SUBMITTED', '该语音片段已经提交。', 409);
          payload = {
            text: body.text,
            intent: body.intent ?? 'explain',
            input: body.input ?? 'text',
            ...(body.utteranceId ? { utteranceId: body.utteranceId } : {}),
          };
        } else if (body.type === 'page_exposure') {
          if (
            !find(state.materials, session.materialVersionId).content.pages?.some(
              (p) => p.id === body.pageId,
            )
          )
            throw new TrainingError('PAGE_NOT_FOUND', '页面不属于本轮冻结材料。');
          run.pageId = body.pageId;
          run.boardOpen = false;
          payload = { pageId: body.pageId };
        } else if (body.type === 'board_visibility') {
          run.boardOpen = body.open;
          payload = { open: body.open };
        } else {
          if (!run.boardOpen) throw new TrainingError('BOARD_NOT_VISIBLE', '请先打开白板。');
          const operation = body.operation;
          if (operation.kind === 'add') {
            if (run.board.elements.length >= 300)
              throw new TrainingError('LIMIT_REACHED', '请先清理部分板书。');
            if (run.board.elements.some((e) => e.id === operation.element.id))
              throw new TrainingError('ELEMENT_CONFLICT', '板书元素标识重复。', 409);
            const cleaned = cleanSlide({ ...run.board, elements: [operation.element] });
            operation.element = cleaned.elements[0];
            run.board.elements.push(operation.element);
          } else if (operation.kind === 'clear') run.board.elements = [];
          else run.board.elements = run.board.elements.filter((e) => e.id !== operation.elementId);
          payload = { operation };
        }
        cancelStudentTurns(state, session);
        const event = appendEvent(state, session, body.clientEventId, body.type, payload);
        return { session, event, accepted: true };
      });
      return { ...result, duplicate };
    });
  }
}
