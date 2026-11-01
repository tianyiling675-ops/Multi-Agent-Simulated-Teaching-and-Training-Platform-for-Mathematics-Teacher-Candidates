import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { emptyMaterial, TrainingError } from '@/lib/teacher-training/contracts';
import { TrainingService } from '@/lib/teacher-training/service';
import { SqliteTrainingStore } from '@/lib/teacher-training/sqlite-store';
import {
  ensureTrainingSchema,
  PgTrainingStore,
  type TrainingQueryable,
} from '@/lib/teacher-training/pg-store';
import type { TrainingStore } from '@/lib/teacher-training/store';

const key = () => randomUUID();
async function fixture(store: TrainingStore, owner = key()) {
  const service = new TrainingService(store, owner);
  const project = await service.createProject({
    title: '椭圆',
    grade: '高中',
    scope: '长半轴方向',
    clientRequestId: key(),
  });
  const content = {
    ...emptyMaterial(),
    objectives: '解释方向',
    process: '比较横向和纵向椭圆，用变式检查理解。',
  };
  await service.saveDraft(project.id, { expectedRevision: 0, content });
  const material = await service.confirmDraft(project.id, { expectedRevision: 1 });
  const config = await service.createClass({
    projectId: project.id,
    template: 'mixed',
    clientRequestId: key(),
    students: [
      {
        id: 'lin',
        name: '小林',
        priorKnowledge: '知道椭圆定义',
        expression: 'responsive',
        misconceptions: ['SECRET_VERTICAL'],
      },
    ],
  });
  const sessionInput = {
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'text',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 15,
    clientRequestId: key(),
  };
  const session = await service.createSession(sessionInput);
  return { service, owner, project, content, material, config, session, sessionInput };
}

for (const backend of ['sqlite', 'postgres-contract'] as const) {
  describe(`teacher training contract: ${backend}`, () => {
    let store: TrainingStore;
    let close: () => Promise<void> | void;
    beforeAll(async () => {
      if (backend === 'sqlite') {
        const sqlite = new SqliteTrainingStore(':memory:');
        store = sqlite;
        close = () => sqlite.close();
      } else {
        const pg = new PGlite();
        await ensureTrainingSchema(pg as TrainingQueryable);
        store = new PgTrainingStore(pg as TrainingQueryable, (body) =>
          pg.transaction((tx) => body(tx as TrainingQueryable)),
        );
        close = () => pg.close();
      }
    });
    afterAll(async () => {
      await close();
    });

    it('freezes content and original sources; draft edits cannot change historical evidence', async () => {
      const f = await fixture(store);
      await f.service.saveDraft(f.project.id, {
        expectedRevision: 1,
        content: {
          ...f.content,
          process: '修改后的解释',
          sources: [{ name: '教案.txt', format: 'txt', originalText: '原始上传内容' }],
        },
      });
      const v2 = await f.service.confirmDraft(f.project.id, { expectedRevision: 2 });
      expect(v2.number).toBe(2);
      expect(v2.parentVersionId).toBe(f.material.id);
      expect(v2.contentHash).not.toBe(f.material.contentHash);
      expect(v2.sourceHashes).toHaveLength(1);
      const old = await f.service.getSession(f.session.id);
      expect(old.material.content.process).toBe(f.content.process);
      expect(old.material.content.sources).toEqual([]);
      expect((await f.service.confirmDraft(f.project.id, { expectedRevision: 2 })).id).toBe(v2.id);
    });

    it('allows exactly one concurrent draft writer; a rejected write is rolled back', async () => {
      const f = await fixture(store);
      const results = await Promise.allSettled(
        ['A', 'B'].map((process) =>
          f.service.saveDraft(f.project.id, {
            expectedRevision: 1,
            content: { ...f.content, process },
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect((await f.service.getProject(f.project.id)).draft.revision).toBe(2);
    });

    it('keeps the same revision and version when unchanged content is saved again', async () => {
      const f = await fixture(store);
      const saved = await f.service.saveDraft(f.project.id, {
        expectedRevision: 1,
        content: f.content,
      });
      expect(saved.revision).toBe(1);
      const version = await f.service.confirmDraft(f.project.id, {
        expectedRevision: saved.revision,
      });
      expect(version.id).toBe(f.material.id);
      expect((await f.service.getProject(f.project.id)).materials).toHaveLength(1);
    });

    it('checks content integrity while preserving initial snapshot hash semantics', async () => {
      const f = await fixture(store);
      expect(f.material.hashAlgorithm).toBe('sha256-canonical-json-v1');
      await store.update(f.owner, (state) => {
        const material = state.materials[f.material.id];
        delete material.hashAlgorithm;
        material.contentHash = createHash('sha256')
          .update(JSON.stringify(material.content))
          .digest('hex');
      });
      const legacy = await f.service.createSession({ ...f.sessionInput, clientRequestId: key() });
      expect(legacy.materialVersionId).toBe(f.material.id);
      await store.update(f.owner, (state) => {
        state.materials[f.material.id].content.process = 'corrupted snapshot';
      });
      await expect(
        f.service.createSession({ ...f.sessionInput, clientRequestId: key() }),
      ).rejects.toMatchObject({ code: 'MATERIAL_CORRUPTED' });
    });

    it('deduplicates creation and refuses reuse of the same key with changed bindings', async () => {
      const f = await fixture(store);
      expect((await f.service.createSession(f.sessionInput)).id).toBe(f.session.id);
      await expect(
        f.service.createSession({ ...f.sessionInput, plannedMinutes: 20 }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect((await f.service.getProject(f.project.id)).sessions).toHaveLength(1);
    });

    it('persists ordered facts once and keeps pause/end outside model control', async () => {
      const f = await fixture(store);
      const start = { command: 'start', expectedRevision: 0, clientEventId: key() };
      await f.service.command(f.session.id, start);
      const utterance = {
        type: 'teacher_text',
        text: '请解释你的判断依据。',
        expectedRevision: 1,
        clientEventId: key(),
      };
      const results = await Promise.all([
        f.service.submitEvent(f.session.id, utterance),
        f.service.submitEvent(f.session.id, utterance),
      ]);
      expect(results[0].event.id).toBe(results[1].event.id);
      await expect(
        f.service.submitEvent(f.session.id, { ...utterance, text: '另一句话' }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await f.service.command(f.session.id, {
        command: 'pause',
        expectedRevision: 2,
        clientEventId: key(),
      });
      await expect(
        f.service.submitEvent(f.session.id, {
          ...utterance,
          clientEventId: key(),
          expectedRevision: 3,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_STATE_CONFLICT' });
      await expect(
        f.service.command(f.session.id, {
          command: 'end',
          expectedRevision: 3,
          clientEventId: key(),
        }),
      ).rejects.toMatchObject({ code: 'END_CONFIRMATION_REQUIRED' });
      await f.service.command(f.session.id, {
        command: 'end',
        confirmed: true,
        expectedRevision: 3,
        clientEventId: key(),
      });
      await expect(
        f.service.submitEvent(f.session.id, {
          ...utterance,
          clientEventId: key(),
          expectedRevision: 4,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_STATE_CONFLICT' });
      const detail = await f.service.getSession(f.session.id);
      expect(detail.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(detail.events.map((e) => e.type)).toEqual(['start', 'teacher_text', 'pause', 'end']);
      // Every teacher turn also revokes pending student output.
      expect(detail.session.speakerEpoch).toBe(4);
      expect(detail.session.totalScore).toBeNull();
      expect(detail.session.scoreStatus).toBe('pending_standard');
      // A late retry of an accepted command returns its receipt, never reopens the session.
      await f.service.command(f.session.id, start);
      expect((await f.service.getSession(f.session.id)).session.status).toBe('ended');
    });

    it('reading does not create events or resume a running classroom', async () => {
      const f = await fixture(store);
      await f.service.command(f.session.id, {
        command: 'start',
        expectedRevision: 0,
        clientEventId: key(),
      });
      expect(await f.service.getSession(f.session.id)).toEqual(
        await f.service.getSession(f.session.id),
      );
      const recovered = await f.service.command(f.session.id, {
        command: 'recover',
        expectedRevision: 1,
        clientEventId: key(),
      });
      expect(recovered.session.status).toBe('paused');
      await expect(
        f.service.command(f.session.id, {
          command: 'call_on',
          studentId: 'foreign',
          expectedRevision: 2,
          clientEventId: key(),
        }),
      ).rejects.toBeInstanceOf(TrainingError);
    });

    it('rejects cross-owner and cross-project references and hides private misconceptions', async () => {
      const f = await fixture(store);
      const other = new TrainingService(store, key());
      await expect(other.getProject(f.project.id)).rejects.toMatchObject({ status: 404 });
      await expect(other.getSession(f.session.id)).rejects.toMatchObject({ status: 404 });
      await expect(
        other.command(f.session.id, {
          command: 'start',
          expectedRevision: 0,
          clientEventId: key(),
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(await other.listProjects()).toEqual([]);
      expect(JSON.stringify(await f.service.getProject(f.project.id))).not.toContain(
        'SECRET_VERTICAL',
      );
      expect(JSON.stringify(await f.service.getSession(f.session.id))).not.toContain(
        'SECRET_VERTICAL',
      );
      const another = await f.service.createProject({
        title: '二次函数',
        grade: '初中',
        scope: '顶点',
        clientRequestId: key(),
      });
      await expect(
        f.service.createSession({
          ...f.sessionInput,
          projectId: another.id,
          clientRequestId: key(),
        }),
      ).rejects.toMatchObject({ code: 'VERSION_SCOPE_MISMATCH' });
    });

    it('rejects unfinished material and forged fields instead of silently accepting them', async () => {
      const f = await fixture(store);
      await expect(f.service.getProject('constructor')).rejects.toMatchObject({ status: 404 });
      await expect(
        f.service.createSession({ ...f.sessionInput, totalScore: 99 }),
      ).rejects.toThrow();
      await expect(
        f.service.submitEvent(f.session.id, {
          type: 'student_speech',
          text: '懂了',
          expectedRevision: 0,
          clientEventId: key(),
        }),
      ).rejects.toThrow();
      await f.service.saveDraft(f.project.id, { expectedRevision: 1, content: emptyMaterial() });
      await expect(
        f.service.confirmDraft(f.project.id, { expectedRevision: 2 }),
      ).rejects.toMatchObject({ code: 'MATERIAL_INCOMPLETE' });
    });
  });
}

it('survives closing and reopening the local database without rewriting a confirmed version', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'teacher-training-contract-')), 'training.sqlite');
  const first = new SqliteTrainingStore(path);
  const f = await fixture(first);
  const expected = await f.service.getSession(f.session.id);
  first.close();
  const second = new SqliteTrainingStore(path);
  try {
    expect(await new TrainingService(second, f.owner).getSession(f.session.id)).toEqual(expected);
  } finally {
    second.close();
  }
  // Retain the isolated temp fixture; never delete user files during acceptance.
});
