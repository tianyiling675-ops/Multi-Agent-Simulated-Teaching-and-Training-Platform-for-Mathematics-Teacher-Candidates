import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SqliteTrainingStore } from '@/lib/teacher-training/sqlite-store';
import { TrainingService } from '@/lib/teacher-training/service';
import { PreparationService } from '@/lib/teacher-training/preparation-service';
import { emptyMaterial } from '@/lib/teacher-training/contracts';
const mocks = vi.hoisted(() => ({ outline: vi.fn(), page: vi.fn() }));
vi.mock('@openmaic/generation', () => ({
  generateSceneOutlinesFromRequirements: mocks.outline,
  generateSceneContent: mocks.page,
}));
vi.mock('@/lib/teacher-training/model', () => ({ trainingModel: async () => async () => '' }));
const key = () => randomUUID();
let store: SqliteTrainingStore;
beforeEach(() => {
  store = new SqliteTrainingStore(':memory:');
  mocks.outline.mockReset();
  mocks.page.mockReset();
});
afterEach(() => store.close());
async function fixture() {
  const service = new TrainingService(store, 'owner');
  const prep = new PreparationService(store, 'owner');
  const project = await service.createProject({
    title: '椭圆',
    grade: '高二',
    scope: '方向',
    clientRequestId: key(),
  });
  mocks.outline.mockResolvedValue({
    success: true,
    data: {
      outlines: [0, 1].map((i) => ({
        id: String(i),
        type: 'slide',
        title: '页' + i,
        description: '比较方程',
        keyPoints: ['解释'],
        order: i,
      })),
    },
  });
  const job = await prep.begin(
    project.id,
    { expectedRevision: 0, clientRequestId: key() },
    new Request('http://localhost'),
  );
  return { service, prep, project, job };
}
const page = () => ({
  elements: [
    {
      id: 'text_1',
      type: 'text',
      left: 40,
      top: 40,
      width: 800,
      height: 100,
      rotate: 0,
      content: '<p>椭圆</p>',
      defaultFontName: 'Noto Sans SC',
      defaultColor: '#263e36',
    },
  ],
});
describe('incremental preparation', () => {
  it('generates from the reviewed lesson plan and edited references, excluding the archived lesson text', async () => {
    const f = await fixture();
    await f.service.saveDraft(f.project.id, {
      expectedRevision: 0,
      content: {
        ...emptyMaterial(),
        process: 'REVIEWED_LESSON_ONLY',
        sources: [
          {
            name: '教案.docx',
            format: 'docx',
            purpose: 'lesson_plan',
            originalText: 'REMOVED_LESSON_SECTION',
          },
          {
            name: '参考.md',
            format: 'md',
            purpose: 'reference',
            originalText: 'OLD_REFERENCE',
            referenceText: 'REVIEWED_REFERENCE',
          },
        ],
      },
    });
    await f.prep.begin(
      f.project.id,
      { expectedRevision: 1, clientRequestId: key() },
      new Request('http://localhost'),
    );
    const context = mocks.outline.mock.calls.at(-1)![1];
    expect(context).toContain('REVIEWED_LESSON_ONLY');
    expect(context).toContain('REVIEWED_REFERENCE');
    expect(context).not.toContain('REMOVED_LESSON_SECTION');
    expect(context).not.toContain('OLD_REFERENCE');
    expect((await f.service.getProject(f.project.id)).draft.content.sources[0].originalText).toBe(
      'REMOVED_LESSON_SECTION',
    );
  });
  it('preserves successful pages and retries failures without duplicate pages', async () => {
    const f = await fixture();
    mocks.page
      .mockResolvedValueOnce(page())
      .mockRejectedValueOnce(new Error('provider'))
      .mockResolvedValueOnce(page());
    const first = await f.prep.page(
      f.job.id,
      { outlineId: f.job.outlines[0].id },
      new Request('http://localhost'),
    );
    await expect(
      f.prep.page(f.job.id, { outlineId: f.job.outlines[1].id }, new Request('http://localhost')),
    ).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
    expect((await f.service.getProject(f.project.id)).draft.content.pages).toHaveLength(1);
    await f.prep.page(
      f.job.id,
      { outlineId: f.job.outlines[0].id },
      new Request('http://localhost'),
    );
    expect(mocks.page).toHaveBeenCalledTimes(2);
    const result = await f.prep.page(
      f.job.id,
      { outlineId: f.job.outlines[1].id },
      new Request('http://localhost'),
    );
    expect(result.job.status).toBe('complete');
    expect(result.draft.content.pages).toHaveLength(2);
    expect(first.draft.content.pages).toHaveLength(1);
  });
  it('edits incomplete outlines with revision checks and refuses stale generation after draft edits', async () => {
    const f = await fixture();
    const updated = await f.prep.revise(f.job.id, {
      expectedOutlineRevision: 0,
      outlines: f.job.outlines.map((o) => ({
        id: o.id,
        title: '编辑后 ' + o.title,
        description: o.description,
        keyPoints: o.keyPoints,
      })),
    });
    expect(updated.outlineRevision).toBe(1);
    await expect(
      f.prep.revise(f.job.id, {
        expectedOutlineRevision: 0,
        outlines: updated.outlines.map(({ id, title, description, keyPoints }) => ({
          id,
          title,
          description,
          keyPoints,
        })),
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await f.service.saveDraft(f.project.id, {
      expectedRevision: 0,
      content: { ...emptyMaterial(), process: '新草稿' },
    });
    await expect(
      f.prep.page(f.job.id, { outlineId: f.job.outlines[0].id }, new Request('http://localhost')),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it('leases a page outside the transaction and rejects duplicate in-flight work', async () => {
    const f = await fixture();
    let release!: (p: ReturnType<typeof page>) => void;
    let ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    mocks.page.mockImplementationOnce(async () => {
      ready();
      return new Promise((r) => (release = r));
    });
    const first = f.prep.page(
      f.job.id,
      { outlineId: f.job.outlines[0].id },
      new Request('http://localhost'),
    );
    await started;
    await expect(
      f.prep.page(f.job.id, { outlineId: f.job.outlines[0].id }, new Request('http://localhost')),
    ).rejects.toMatchObject({ code: 'PREPARATION_BUSY' });
    // Other short writes are not blocked by the model call.
    await f.service.createProject({
      title: '另一课题',
      grade: '高中',
      scope: '函数',
      clientRequestId: key(),
    });
    release(page());
    await first;
  });
});
