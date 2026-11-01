import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requestKey, TrainingError } from './contracts';
import { reactionSchema, type StudentReaction, type StudentTurn } from './classroom-contracts';
import { appendEvent, classroomRun, find, once } from './service';
import type { TrainingStore } from './store';
import { studentVisibleContext } from './student-context';

const requestSchema = z
  .object({ triggerId: z.string().max(100), clientRequestId: requestKey })
  .strict();
const deliverySchema = z
  .object({
    turnId: z.string().max(100),
    speakerEpoch: z.number().int(),
    clientEventId: requestKey,
    length: z.number().int().positive(),
  })
  .strict();
export type StudentGenerator = (
  context: ReturnType<typeof studentVisibleContext>,
  signal?: AbortSignal,
) => Promise<StudentReaction>;

function publicTurn(turn: StudentTurn) {
  return {
    id: turn.id,
    studentId: turn.studentId,
    speakerEpoch: turn.epoch,
    status: turn.status,
    committedLength: turn.committedLength,
    speech: turn.reaction?.speech ?? '',
    hands: turn.reaction?.hands ?? [],
  };
}

/** Dedicated training execution: one server-authorized student per call. The
 * learning-mode director / Pi tools never receive a training session handle. */
export class ClassroomService {
  constructor(
    private store: TrainingStore,
    private ownerId: string,
  ) {}

  async react(sessionId: string, input: unknown, generate: StudentGenerator, signal?: AbortSignal) {
    const body = requestSchema.parse(input);
    const prepared = await this.store.update(this.ownerId, (state) => {
      const session = find(state.sessions, sessionId);
      const run = classroomRun(state, sessionId);
      const previous = Object.values(run.turns).find((t) => t.requestId === body.clientRequestId);
      if (previous) {
        if (previous.triggerId !== body.triggerId)
          throw new TrainingError('IDEMPOTENCY_CONFLICT', '生成请求标识已用于其他事件。', 409);
        if (previous.epoch !== session.speakerEpoch || session.status !== 'running')
          throw new TrainingError('TURN_CANCELLED', '教师已经改变课堂状态，本次回答已取消。', 409);
        if (previous.status === 'proposed' || previous.status === 'delivered')
          return { turn: previous, context: null };
        if (
          previous.status === 'generating' &&
          Date.now() - Date.parse(previous.createdAt) < 180_000
        )
          throw new TrainingError('TURN_IN_PROGRESS', '学生正在思考，请稍候。', 409);
        throw new TrainingError('TURN_FAILED', '本次生成未完成，请重新请求。', 409);
      }
      if (session.status !== 'running')
        throw new TrainingError('SESSION_STATE_CONFLICT', '课堂尚未进行或已暂停。', 409);
      const trigger = state.events[sessionId].find((e) => e.id === body.triggerId);
      if (
        !trigger ||
        trigger.seq !== session.seq ||
        !['teacher_text', 'call_on'].includes(trigger.type)
      )
        throw new TrainingError('STALE_TRIGGER', '课堂内容已更新，请以最近的发言或点名为准。', 409);
      const active = Object.values(run.turns).find(
        (t) => t.epoch === session.speakerEpoch && ['generating', 'proposed'].includes(t.status),
      );
      if (active && Date.now() - Date.parse(active.createdAt) < 180_000)
        throw new TrainingError('TURN_IN_PROGRESS', '当前已有学生回应，请先收回发言或等待。', 409);
      if (active) active.status = 'cancelled';
      const turn: StudentTurn = {
        id: `turn_${randomUUID()}`,
        requestId: body.clientRequestId,
        triggerId: trigger.id,
        ...(trigger.type === 'call_on' ? { studentId: trigger.payload.studentId } : {}),
        epoch: session.speakerEpoch,
        cutoff: session.seq,
        status: 'generating',
        committedLength: 0,
        createdAt: new Date().toISOString(),
      };
      run.turns[turn.id] = turn;
      return { turn, context: studentVisibleContext(state, sessionId, turn) };
    });
    if (!prepared.context) return publicTurn(prepared.turn);
    try {
      const reaction = reactionSchema.parse(await generate(prepared.context, signal));
      if (signal?.aborted) throw new TrainingError('TURN_CANCELLED', '生成已取消。', 409);
      return await this.store.update(this.ownerId, (state) => {
        const session = find(state.sessions, sessionId);
        const run = classroomRun(state, sessionId);
        const turn = find(run.turns, prepared.turn.id);
        if (
          session.status !== 'running' ||
          session.speakerEpoch !== turn.epoch ||
          turn.status !== 'generating'
        )
          throw new TrainingError(
            'TURN_CANCELLED',
            '教师已收回发言或改变课堂内容，旧回答不会发布。',
            409,
          );
        const studentIds = new Set(
          state.classes[session.classConfigVersionId].students.map((s) => s.id),
        );
        if (reaction.hands.some((id) => !studentIds.has(id)))
          throw new TrainingError('MODEL_OUTPUT_INVALID', '学生反应包含未知身份。', 502);
        if (!turn.studentId && (reaction.speech || reaction.changes.length))
          throw new TrainingError('MODEL_OUTPUT_INVALID', '全班提问只能产生举手候选。', 502);
        if (turn.studentId && reaction.hands.length)
          throw new TrainingError('MODEL_OUTPUT_INVALID', '点名回答不能改变其他学生的举手。', 502);
        if (turn.studentId && !reaction.speech.trim())
          throw new TrainingError('MODEL_OUTPUT_INVALID', '学生未返回有效回答。', 502);
        turn.reaction = reaction;
        turn.status = turn.studentId ? 'proposed' : 'delivered';
        if (!turn.studentId) run.hands = [...new Set(reaction.hands)];
        return publicTurn(turn);
      });
    } catch (error) {
      await this.store.update(this.ownerId, (state) => {
        const turn = state.classrooms?.[sessionId]?.turns[prepared.turn.id];
        if (turn?.status === 'generating') turn.status = 'failed';
      });
      if (error instanceof TrainingError) throw error;
      throw new TrainingError(
        'STUDENT_GENERATION_FAILED',
        '学生回应未生成成功。请检查模型设置后重试，已保存的课堂不受影响。',
        502,
      );
    }
  }

  async deliver(sessionId: string, input: unknown) {
    const body = deliverySchema.parse(input);
    return this.store.update(this.ownerId, (state) =>
      once(state, `delivery:${sessionId}:${body.clientEventId}`, body, () => {
        const session = find(state.sessions, sessionId);
        const run = classroomRun(state, sessionId);
        const turn = find(run.turns, body.turnId);
        if (
          session.status !== 'running' ||
          turn.epoch !== session.speakerEpoch ||
          body.speakerEpoch !== turn.epoch ||
          turn.status !== 'proposed'
        )
          throw new TrainingError('TURN_CANCELLED', '该回答已失去发言权，不能进入课堂记录。', 409);
        const reaction = turn.reaction!;
        if (
          !turn.studentId ||
          body.length <= turn.committedLength ||
          body.length > reaction.speech.length
        )
          throw new TrainingError('DELIVERY_RANGE_INVALID', '回答发布范围无效。');
        const text = reaction.speech.slice(turn.committedLength, body.length);
        const event = appendEvent(
          state,
          session,
          body.clientEventId,
          'student_speech',
          { text, studentId: turn.studentId, turnId: turn.id, deliveredLength: body.length },
          'student',
        );
        turn.committedLength = body.length;
        if (body.length === reaction.speech.length) {
          turn.status = 'delivered';
          run.activeStudentId = null;
          const concepts = (run.studentStates[turn.studentId] ??= []);
          const visibleEvents = new Set(
            state.events[sessionId]
              .filter(
                (e) =>
                  e.seq <= turn.cutoff &&
                  ['teacher_text', 'student_speech', 'page_exposure', 'board_operation'].includes(
                    e.type,
                  ),
              )
              .map((e) => e.id),
          );
          visibleEvents.add(event.id);
          const responseEvents = state.events[sessionId]
            .filter((e) => e.payload.turnId === turn.id)
            .map((e) => e.id);
          responseEvents.forEach((id) => visibleEvents.add(id));
          for (const change of reaction.changes) {
            const evidenceIds = change.evidenceIds.flatMap((id) =>
              id === 'current_response' ? responseEvents : [id],
            );
            if (!evidenceIds.every((id) => visibleEvents.has(id))) continue;
            const existing = concepts.find((c) => c.concept === change.concept);
            if ((existing?.revision ?? 0) !== change.oldRevision) continue;
            if (change.level === 'demonstrated') {
              const checked = state.events[sessionId].some(
                (e) =>
                  evidenceIds.includes(e.id) &&
                  e.type === 'teacher_text' &&
                  e.payload.intent === 'check',
              );
              if (
                !checked ||
                !evidenceIds.includes(event.id) ||
                !['new_example', 'transfer_answer'].includes(change.demonstratedBy) ||
                reaction.speech.trim().length < 20
              )
                continue;
            }
            const next = {
              concept: change.concept,
              level: change.level,
              revision: change.oldRevision + 1,
              evidenceIds,
            };
            if (existing) Object.assign(existing, next);
            else concepts.push(next);
          }
        }
        return { event, session };
      }),
    );
  }
}
