import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SqliteTrainingStore } from '@/lib/teacher-training/sqlite-store';
import { TrainingService } from '@/lib/teacher-training/service';
import { ClassroomService } from '@/lib/teacher-training/classroom-service';
import { emptyMaterial } from '@/lib/teacher-training/contracts';
import { blankSlide } from '@/lib/teacher-training/slides';
import { cleanSlide } from '@/lib/teacher-training/materials';
import type { StudentReaction } from '@/lib/teacher-training/classroom-contracts';
const key = () => randomUUID();
const stores: SqliteTrainingStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});
const textElement = (text: string) => ({
  id: key(),
  type: 'text' as const,
  left: 40,
  top: 40,
  width: 800,
  height: 100,
  rotate: 0,
  content: '<p>' + text + '</p>',
  defaultFontName: 'Noto Sans SC',
  defaultColor: '#263e36',
});
async function fixture() {
  const store = new SqliteTrainingStore(':memory:');
  stores.push(store);
  const owner = key();
  const service = new TrainingService(store, owner);
  const classroom = new ClassroomService(store, owner);
  const project = await service.createProject({
    title: '椭圆',
    grade: '高二',
    scope: '分母与长半轴',
    clientRequestId: key(),
  });
  const content = {
    ...emptyMaterial(),
    notes: 'SECRET_NOTES',
    exercises: 'SECRET_ANSWER',
    sources: [{ name: '来源.md', format: 'md' as const, originalText: 'SECRET_SOURCE' }],
    pages: ['DISPLAYED', 'FUTURE_PAGE'].map((title, i) => ({
      id: 'page_' + i,
      title,
      source: 'edited' as const,
      canvas: {
        ...blankSlide('page_' + i),
        remark: 'SECRET_REMARK',
        elements: [textElement(title)],
      },
    })),
  };
  const draft = await service.saveDraft(project.id, { expectedRevision: 0, content });
  const material = await service.confirmDraft(project.id, { expectedRevision: draft.revision });
  const config = await service.createClass({
    projectId: project.id,
    template: 'mixed',
    students: [
      {
        id: 'lin',
        name: '小林',
        priorKnowledge: '基础概念',
        expression: 'responsive',
        misconceptions: ['PRIVATE_CONCEPT'],
      },
      {
        id: 'zhou',
        name: '小周',
        priorKnowledge: '基础概念',
        expression: 'reserved',
        misconceptions: [],
      },
    ],
    clientRequestId: key(),
  });
  const session = await service.createSession({
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'mixed',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 15,
    clientRequestId: key(),
  });
  const command = async (command: string, studentId?: string) =>
    service.command(session.id, {
      command,
      studentId,
      expectedRevision: (await service.getSession(session.id)).session.revision,
      clientEventId: key(),
      ...(command === 'end' ? { confirmed: true } : {}),
    });
  const event = async (payload: Record<string, unknown>) =>
    service.submitEvent(session.id, {
      ...payload,
      expectedRevision: (await service.getSession(session.id)).session.revision,
      clientEventId: key(),
    });
  await command('start');
  return {
    store,
    owner,
    service,
    classroom,
    project,
    content,
    material,
    config,
    session,
    command,
    event,
  };
}
const response: StudentReaction = {
  hands: [],
  speech: '我认为这个新例子的长半轴沿着纵轴，因为y平方的分母更大。',
  changes: [],
};
describe('teacher-owned classroom', () => {
  it('freezes courseware-only material and excludes future/private data from student context', async () => {
    const f = await fixture();
    const trigger = await f.event({
      type: 'teacher_text',
      text: '请观察当前页。',
      intent: 'question',
    });
    await f.classroom.react(
      f.session.id,
      { triggerId: trigger.event.id, clientRequestId: key() },
      async (ctx) => {
        const json = JSON.stringify(ctx);
        expect(json).toContain('DISPLAYED');
        for (const secret of [
          'FUTURE_PAGE',
          'SECRET_NOTES',
          'SECRET_ANSWER',
          'SECRET_SOURCE',
          'SECRET_REMARK',
        ])
          expect(json).not.toContain(secret);
        return { hands: ['lin'], speech: '', changes: [] };
      },
    );
    const before = await f.service.getSession(f.session.id);
    expect(before.classroom.hands).toEqual(['lin']);
    expect(before.events.some((e) => e.type === 'student_speech')).toBe(false);
    expect(JSON.stringify(before)).not.toContain('PRIVATE_CONCEPT');
    await f.service.saveDraft(f.project.id, {
      expectedRevision: 1,
      content: { ...f.content, pages: [{ ...f.content.pages[0], title: 'MODIFIED' }] },
    });
    expect((await f.service.getSession(f.session.id)).material.content.pages?.[0].title).toBe(
      'DISPLAYED',
    );
  });
  it('only gives the selected student private state and commits public speech once', async () => {
    const f = await fixture();
    const trigger = await f.command('call_on', 'lin');
    const requestId = key();
    const turn = await f.classroom.react(
      f.session.id,
      { triggerId: trigger.event.id, clientRequestId: requestId },
      async (ctx) => {
        expect(ctx.students.map((s) => s.id)).toEqual(['lin']);
        return response;
      },
    );
    expect(
      (await f.service.getSession(f.session.id)).events.some((e) => e.type === 'student_speech'),
    ).toBe(false);
    const delivery = {
      turnId: turn.id,
      speakerEpoch: turn.speakerEpoch,
      clientEventId: key(),
      length: response.speech.length,
    };
    const one = await f.classroom.deliver(f.session.id, delivery);
    const two = await f.classroom.deliver(f.session.id, delivery);
    expect(two.event.id).toBe(one.event.id);
    expect(
      (await f.service.getSession(f.session.id)).events.filter((e) => e.type === 'student_speech'),
    ).toHaveLength(1);
  });
  for (const command of ['interrupt', 'pause', 'call_on', 'end'])
    it('rejects a late model result after ' + command, async () => {
      const f = await fixture();
      const trigger = await f.command('call_on', 'lin');
      let release!: (r: StudentReaction) => void;
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const result = f.classroom.react(
        f.session.id,
        { triggerId: trigger.event.id, clientRequestId: key() },
        async () => {
          ready();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      );
      const rejected = expect(result).rejects.toMatchObject({ code: 'TURN_CANCELLED' });
      await started;
      await f.command(command, command === 'call_on' ? 'zhou' : undefined);
      release(response);
      await rejected;
      expect(
        (await f.service.getSession(f.session.id)).events.some((e) => e.type === 'student_speech'),
      ).toBe(false);
    });
  it('teacher speech preempts proposed student output', async () => {
    const f = await fixture();
    const trigger = await f.command('call_on', 'lin');
    const turn = await f.classroom.react(
      f.session.id,
      { triggerId: trigger.event.id, clientRequestId: key() },
      async () => response,
    );
    await f.event({ type: 'teacher_text', text: '我再补充一下。' });
    await expect(
      f.classroom.deliver(f.session.id, {
        turnId: turn.id,
        speakerEpoch: turn.speakerEpoch,
        clientEventId: key(),
        length: response.speech.length,
      }),
    ).rejects.toMatchObject({ code: 'TURN_CANCELLED' });
  });
  it('only applies supported state changes after full publication', async () => {
    const f = await fixture();
    const check = await f.event({
      type: 'teacher_text',
      text: '请判断这个新方程并说明理由。',
      intent: 'check',
    });
    const trigger = await f.command('call_on', 'lin');
    const turn = await f.classroom.react(
      f.session.id,
      { triggerId: trigger.event.id, clientRequestId: key() },
      async () => ({
        ...response,
        changes: [
          {
            concept: '方向',
            oldRevision: 0,
            level: 'demonstrated',
            evidenceIds: [check.event.id, 'current_response'],
            demonstratedBy: 'transfer_answer',
          },
          {
            concept: '伪造证据',
            oldRevision: 0,
            level: 'partial',
            evidenceIds: ['invented'],
            demonstratedBy: 'none',
          },
        ],
      }),
    );
    await f.classroom.deliver(f.session.id, {
      turnId: turn.id,
      speakerEpoch: turn.speakerEpoch,
      clientEventId: key(),
      length: 10,
    });
    expect(
      (await f.store.read(f.owner)).classrooms?.[f.session.id].studentStates.lin,
    ).toBeUndefined();
    await f.classroom.deliver(f.session.id, {
      turnId: turn.id,
      speakerEpoch: turn.speakerEpoch,
      clientEventId: key(),
      length: response.speech.length,
    });
    expect(
      (await f.store.read(f.owner)).classrooms?.[f.session.id].studentStates.lin.map(
        (c) => c.concept,
      ),
    ).toEqual(['方向']);
    expect(JSON.stringify(await f.service.getSession(f.session.id))).not.toContain('studentStates');
  });
  it('isolates board and turns by session and owner', async () => {
    const f = await fixture();
    await f.event({ type: 'board_visibility', open: true });
    await f.event({
      type: 'board_operation',
      operation: { kind: 'add', element: textElement('板书') },
    });
    const second = await f.service.createSession({
      projectId: f.project.id,
      materialVersionId: f.material.id,
      classConfigVersionId: f.config.id,
      inputMode: 'mixed',
      assistance: 'independent',
      scope: 'full',
      plannedMinutes: 10,
      clientRequestId: key(),
    });
    expect((await f.service.getSession(second.id)).classroom.board.elements).toHaveLength(0);
    await expect(
      new TrainingService(f.store, key()).getSession(f.session.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const before = await f.service.getSession(f.session.id);
    await f.service.getSession(f.session.id);
    expect((await f.service.getSession(f.session.id)).events).toEqual(before.events);
  });
  it('rejects autonomous whole-class speech and unknown hands', async () => {
    const f = await fixture();
    const trigger = await f.event({ type: 'teacher_text', text: '谁想回答？', intent: 'question' });
    for (const reaction of [response, { hands: ['outsider'], speech: '', changes: [] }])
      await expect(
        f.classroom.react(
          f.session.id,
          { triggerId: trigger.event.id, clientRequestId: key() },
          async () => reaction as StudentReaction,
        ),
      ).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });
  it('validates malformed slides and sanitizes HTML without losing mathematical content', () => {
    const cleaned = cleanSlide({
      ...blankSlide('slide'),
      elements: [textElement('<script>alert(1)</script><b>椭圆</b><img src=x onerror=alert(1)>')],
    });
    expect(JSON.stringify(cleaned)).not.toMatch(/script|onerror/);
    expect(JSON.stringify(cleaned)).toContain('椭圆');
    expect(() => cleanSlide({ ...blankSlide('slide'), viewportSize: 0 })).toThrow();
    expect(() =>
      cleanSlide({
        ...blankSlide('slide'),
        elements: [
          { ...textElement(''), type: 'image', src: 'https://mutable.example/image.png' } as never,
        ],
      }),
    ).toThrow();
  });
});
