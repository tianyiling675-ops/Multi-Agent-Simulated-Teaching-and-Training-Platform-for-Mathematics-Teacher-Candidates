import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTrainingStore } from '../../lib/teacher-training/sqlite-store';
import { TrainingService } from '../../lib/teacher-training/service';
import { blankSlide } from '../../lib/teacher-training/slides';
import { emptyMaterial, type ClassroomEvent } from '../../lib/teacher-training/contracts';
import {
  classroomSeconds,
  evidenceScene,
  reviewEvidence,
  reviewStatistics,
} from '../../lib/teacher-training/review-model';
import { studentVisibleContext } from '../../lib/teacher-training/student-context';
import { reviewFeedback } from '../../lib/teacher-training/review-rubric';
import { parseTrainingLocation, trainingHref } from '../../lib/teacher-training/navigation';

const stores: SqliteTrainingStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
const key = () => crypto.randomUUID();
async function fixture() {
  const store = new SqliteTrainingStore(':memory:');
  stores.push(store);
  const service = new TrainingService(store, 'owner-a');
  const project = await service.createProject({
    title: '椭圆',
    grade: '高二',
    scope: '方向判断',
    clientRequestId: key(),
  });
  const content = {
    ...emptyMaterial(),
    process: '公开讲解',
    notes: '整课私有备注',
    pages: [
      {
        id: 'page_one',
        title: '判断方向',
        canvas: blankSlide('page_one'),
        source: 'edited' as const,
        teacherNotes: '只供教师看的逐页提示',
      },
    ],
  };
  await service.saveDraft(project.id, { expectedRevision: 0, content });
  const material = await service.confirmDraft(project.id, { expectedRevision: 1 });
  const students = [
    {
      id: 'lin',
      name: '小林',
      expression: 'responsive' as const,
      priorKnowledge: '基础',
      misconceptions: ['私有误解'],
    },
  ];
  const config = await service.createClass({
    projectId: project.id,
    template: 'mixed',
    students,
    clientRequestId: key(),
  });
  const session = await service.createSession({
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'text',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 15,
    clientRequestId: key(),
  });
  return { store, service, project, material, students, session };
}

describe('training workspace metadata and private drafts', () => {
  it('returns owner-scoped overview metadata without loading full project responses or mutating a session', async () => {
    const f = await fixture();
    const before = await f.service.getSession(f.session.id);
    const overview = await f.service.getOverview();
    expect(overview.resumeSession).toMatchObject({
      id: f.session.id,
      status: 'ready',
      round: 1,
      materialNumber: 1,
    });
    expect(overview.projects[0]).toMatchObject({
      versionCount: 1,
      sessionCount: 1,
      draftChanged: false,
    });
    expect(JSON.stringify(overview)).not.toMatch(
      /canvas|sourceHashes|misconceptions|逐页提示|私有误解|公开讲解/,
    );
    expect((await f.service.getSession(f.session.id)).events).toEqual(before.events);
    expect(await new TrainingService(f.store, 'owner-b').getOverview()).toEqual({
      projects: [],
      recentSessions: [],
      resumeSession: null,
    });
  });
  it('saves class drafts with revisions while preserving frozen classes and classroom privacy', async () => {
    const f = await fixture();
    const draft = await f.service.saveClassDraft(f.project.id, {
      expectedRevision: 0,
      template: 'support',
      students: [{ ...f.students[0], misconceptions: ['草稿中的私有误解'] }],
      plannedMinutes: 20,
      materialVersionId: f.material.id,
    });
    expect(draft.revision).toBe(1);
    expect(await f.service.getClassDraft(f.project.id)).toEqual(draft);
    await expect(
      f.service.saveClassDraft(f.project.id, {
        expectedRevision: 0,
        template: 'mixed',
        students: f.students,
        plannedMinutes: 15,
        materialVersionId: f.material.id,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const session = await f.service.getSession(f.session.id);
    expect(session.classConfig.template).toBe('mixed');
    expect(JSON.stringify(session.classConfig)).not.toContain('misconceptions');
    expect(JSON.stringify(await f.service.getProject(f.project.id))).not.toContain(
      '草稿中的私有误解',
    );
    await expect(
      new TrainingService(f.store, 'owner-b').getClassDraft(f.project.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('freezes optional page notes but never sends them to a simulated student', async () => {
    const f = await fixture();
    const started = await f.service.command(f.session.id, {
      command: 'start',
      expectedRevision: 0,
      clientEventId: key(),
    });
    const state = await f.store.read('owner-a');
    const context = studentVisibleContext(state, f.session.id, {
      id: 'turn',
      requestId: key(),
      triggerId: started.event.id,
      studentId: 'lin',
      epoch: 0,
      cutoff: state.sessions[f.session.id].seq,
      status: 'generating',
      committedLength: 0,
      createdAt: new Date().toISOString(),
    });
    expect(f.material.content.pages?.[0].teacherNotes).toBe('只供教师看的逐页提示');
    expect(context.pages).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain('只供教师看的逐页提示');
  });
});

describe('read-only classroom evidence', () => {
  it('groups published sentences, counts explicit intents and reconstructs only the selected history', async () => {
    const f = await fixture();
    const detail = await f.service.getSession(f.session.id);
    const baseTime = Date.parse('2026-11-02T00:00:00Z');
    const event = (
      seq: number,
      seconds: number,
      type: string,
      payload: ClassroomEvent['payload'] = {},
    ): ClassroomEvent => ({
      id: `event_${seq}`,
      seq,
      sessionId: f.session.id,
      type,
      clientEventId: `client_${seq}`,
      actorType: type === 'student_speech' ? 'student' : 'teacher',
      occurredAt: new Date(baseTime + seconds * 1000).toISOString(),
      receivedAt: new Date(baseTime + seconds * 1000).toISOString(),
      materialVersionId: f.material.id,
      payload,
      visibility: 'classroom',
      schemaVersion: 1,
    });
    const element = {
      id: 'line_one',
      type: 'text' as const,
      left: 0,
      top: 0,
      width: 300,
      height: 40,
      rotate: 0,
      content: '<p>当时的板书</p>',
      defaultFontName: 'sans-serif',
      defaultColor: '#000',
    };
    detail.events = [
      event(1, 0, 'start'),
      event(2, 1, 'page_exposure', { pageId: 'page_one' }),
      event(3, 2, 'board_visibility', { open: true }),
      event(4, 3, 'board_operation', { operation: { kind: 'add', element } }),
      event(5, 60, 'teacher_text', { text: '判断依据是什么？', intent: 'question' }),
      event(6, 65, 'student_speech', { text: '第一句。', studentId: 'lin', turnId: 'turn_one' }),
      event(7, 66, 'student_speech', { text: '第二句。', studentId: 'lin', turnId: 'turn_one' }),
      event(8, 120, 'pause'),
      event(9, 180, 'resume'),
      event(10, 240, 'teacher_text', { text: '请举个新例子。', intent: 'check' }),
      event(11, 270, 'board_operation', { operation: { kind: 'clear' } }),
      event(12, 300, 'end'),
    ];
    detail.session.endedAt = detail.events.at(-1)!.receivedAt;
    const before = JSON.stringify(detail);
    const speech = reviewEvidence(detail).filter((row) => row.type === 'student_speech');
    expect(speech).toHaveLength(1);
    expect(speech[0]).toMatchObject({
      text: '第一句。第二句。',
      eventIds: ['event_6', 'event_7'],
      lastSeq: 7,
    });
    expect(reviewStatistics(detail)).toEqual({ seconds: 240, questions: 1, checks: 1, answers: 1 });
    expect(evidenceScene(detail, 7).board.elements).toHaveLength(1);
    expect(evidenceScene(detail, 12).board.elements).toHaveLength(0);
    expect(
      evidenceScene(
        {
          ...detail,
          events: [
            ...detail.events.filter((e) => e.seq <= 7),
            event(8, 70, 'page_exposure', { pageId: 'page_one' }),
          ],
        },
        8,
      ),
    ).toMatchObject({ boardOpen: false, page: { id: 'page_one' } });
    expect(evidenceScene(detail, 0)).toMatchObject({ page: null, boardOpen: false });
    const feedback = reviewFeedback(detail, reviewEvidence(detail));
    expect(feedback.map((dimension) => dimension.weight)).toEqual([40, 30, 20, 10]);
    const items = Object.fromEntries(
      feedback.flatMap((dimension) => dimension.items.map((item) => [item.id, item] as const)),
    );
    expect(Object.keys(items)).toHaveLength(14);
    expect(items.thinking.rows.map((row) => row.eventIds)).toEqual([
      ['event_5'],
      ['event_6', 'event_7'],
      ['event_10'],
    ]);
    expect(items.board.rows.map((row) => row.id)).toEqual(['event_4']);
    expect(items.accuracy.status).toBe('manual');
    expect(items.speech.status).toBe('notApplicable');
    expect(items.presence.status).toBe('insufficient');
    expect(items.objectives.status).toBe('insufficient');
    expect(items.participation.note).toContain('1／1');
    expect(
      reviewFeedback(detail, [])
        .flatMap((dimension) => dimension.items)
        .every((item) => item.status === 'insufficient' || item.status === 'notApplicable'),
    ).toBe(true);
    expect(JSON.stringify(detail)).toBe(before);
  });
  it('handles an epoch-zero start and an unfinished interval without counting a pause', () => {
    const event = (type: string, ms: number) =>
      ({ type, receivedAt: new Date(ms).toISOString() }) as ClassroomEvent;
    expect(
      classroomSeconds([event('start', 0), event('pause', 1000), event('resume', 2000)], 4000),
    ).toBe(3);
  });
  it('keeps legacy URLs and round-trips new preparation locations', () => {
    expect(trainingHref(parseTrainingLocation('?project=p1&tab=records&session=s1'))).toBe(
      '/teacher-training?project=p1&tab=records&session=s1',
    );
    const location = {
      view: 'project' as const,
      projectId: 'p1',
      tab: 'preparation' as const,
      section: 'slides' as const,
      pageId: 'page_one',
    };
    expect(parseTrainingLocation(trainingHref(location).split('?')[1])).toEqual(location);
    expect(parseTrainingLocation('?view=history')).toEqual({ view: 'history' });
  });
});
