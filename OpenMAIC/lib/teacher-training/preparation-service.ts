import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  generateSceneOutlinesFromRequirements,
  generateSceneContent,
  type SceneOutline,
} from '@openmaic/generation';
import type { MaterialContent } from './contracts';
import { requestKey, TrainingError } from './contracts';
import type { TrainingStore } from './store';
import { expectRevision, find } from './service';
import { trainingModel } from './model';
import { cleanSlide } from './materials';
import { defaultTheme } from './slides';

export interface PreparationJob {
  id: string;
  projectId: string;
  requestId: string;
  revision: number;
  sourceRevision?: number;
  outlineRevision?: number;
  inFlight?: { token: string; startedAt: number };
  source: MaterialContent;
  requirement: string;
  status: 'planning' | 'ready' | 'running' | 'partial' | 'complete' | 'failed';
  outlines: SceneOutline[];
  completed: string[];
  error?: string;
  createdAt: string;
}
const beginSchema = z
  .object({ expectedRevision: z.number().int().nonnegative(), clientRequestId: requestKey })
  .strict();
const outlineRequest = z
  .object({
    expectedOutlineRevision: z.number().int().nonnegative(),
    outlines: z
      .array(
        z
          .object({
            id: z.string().max(100),
            title: z.string().trim().min(1).max(200),
            description: z.string().max(3000),
            keyPoints: z.array(z.string().max(1000)).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
const pageRequest = z.object({ outlineId: z.string().max(100) }).strict();

export class PreparationService {
  constructor(
    private store: TrainingStore,
    private ownerId: string,
  ) {}
  async begin(projectId: string, input: unknown, request: Request) {
    const body = beginSchema.parse(input);
    const job = await this.store.update(this.ownerId, (state) => {
      const project = find(state.projects, projectId);
      const draft = find(state.drafts, projectId);
      state.preparations ??= {};
      const previous = Object.values(state.preparations).find(
        (j) => j.requestId === body.clientRequestId,
      );
      if (previous) {
        if (
          previous.projectId !== projectId ||
          (previous.sourceRevision ?? previous.revision) !== body.expectedRevision
        )
          throw new TrainingError('IDEMPOTENCY_CONFLICT', '生成请求已用于其他课题。', 409);
        return { job: previous, exists: true };
      }
      expectRevision(draft.revision, body.expectedRevision);
      const created: PreparationJob = {
        id: `prep_${randomUUID()}`,
        requestId: body.clientRequestId,
        projectId,
        revision: draft.revision,
        sourceRevision: draft.revision,
        outlineRevision: 0,
        source: structuredClone(draft.content),
        requirement: `${project.grade}，${project.title}。范围：${project.scope}。为真人教师备课，生成4至8页可编辑幻灯片大纲，所有type必须为slide，不生成AI讲课台词、不使用联网资源、不生成媒体占位符。`,
        outlines: [],
        completed: [],
        status: 'planning',
        createdAt: new Date().toISOString(),
      };
      state.preparations[created.id] = created;
      return { job: created, exists: false };
    });
    if (job.exists) return job.job;
    try {
      const generate = await trainingModel(request, 'scene-outlines-stream');
      const source = job.job.source;
      const result = await generateSceneOutlinesFromRequirements(
        { requirement: job.job.requirement },
        [
          source.objectives,
          source.keyPoints,
          source.process,
          source.exercises,
          // Lesson uploads are archival sources. Their reviewed content already
          // lives in process; re-adding originalText would undo edits/excerpts.
          ...source.sources
            .filter((s) => s.purpose !== 'lesson_plan')
            .map((s) => s.referenceText ?? s.originalText),
        ].join('\n'),
        undefined,
        (system, prompt) => generate(system, prompt),
        { imageGenerationEnabled: false, videoGenerationEnabled: false },
      );
      if (!result.success || !result.data?.outlines.length) throw new Error('没有生成有效大纲');
      const outlines = result.data.outlines;
      if (outlines.length > 20 || outlines.some((o) => o.type !== 'slide'))
        throw new Error('生成大纲超出当前课件支持范围');
      return await this.store.update(this.ownerId, (state) => {
        const saved = find(state.preparations!, job.job.id);
        saved.outlines = outlines.map((o, i) => ({
          ...o,
          id: `page_${randomUUID()}`,
          order: i + 1,
        }));
        saved.status = 'ready';
        return saved;
      });
    } catch {
      await this.store.update(this.ownerId, (state) => {
        const saved = find(state.preparations!, job.job.id);
        saved.status = 'failed';
        saved.error = '大纲生成失败，请检查模型设置后重新生成。';
      });
      throw new TrainingError(
        'PREPARATION_FAILED',
        '大纲生成失败，请检查模型设置。已保存的草稿保持不变。',
        502,
      );
    }
  }
  async revise(jobId: string, input: unknown) {
    const body = outlineRequest.parse(input);
    return this.store.update(this.ownerId, (state) => {
      const job = find(state.preparations ?? {}, jobId);
      expectRevision(job.outlineRevision ?? 0, body.expectedOutlineRevision);
      if (job.inFlight && Date.now() - job.inFlight.startedAt < 180_000)
        throw new TrainingError('PREPARATION_BUSY', '请等待当前页面生成后再修改大纲。', 409);
      if (
        body.outlines.length !== job.outlines.length ||
        new Set(body.outlines.map((o) => o.id)).size !== job.outlines.length ||
        body.outlines.some((o) => !job.outlines.some((p) => p.id === o.id))
      )
        throw new TrainingError('INVALID_REQUEST', '大纲页面标识不一致。');
      job.outlines = body.outlines.map((o, i) => {
        const old = job.outlines.find((p) => p.id === o.id)!;
        if (job.completed.includes(o.id)) return old;
        return { ...old, ...o, order: i + 1 };
      });
      job.outlineRevision = (job.outlineRevision ?? 0) + 1;
      return job;
    });
  }
  async page(jobId: string, input: unknown, request: Request) {
    const body = pageRequest.parse(input);
    const token = randomUUID();
    const prepared = await this.store.update(this.ownerId, (state) => {
      const job = find(state.preparations ?? {}, jobId);
      const draft = find(state.drafts, job.projectId);
      if (job.completed.includes(body.outlineId)) return { job, draft, done: true };
      expectRevision(draft.revision, job.revision);
      if (job.inFlight && Date.now() - job.inFlight.startedAt < 180_000)
        throw new TrainingError('PREPARATION_BUSY', '已有页面正在生成，请稍候。', 409);
      if (
        !job.outlines.some((o) => o.id === body.outlineId) ||
        (draft.content.pages?.length ?? 0) >= 80
      )
        throw new TrainingError('MATERIAL_LIMIT_EXCEEDED', '页面不存在或已达到80页上限。');
      job.inFlight = { token, startedAt: Date.now() };
      return { job, draft, done: false };
    });
    if (prepared.done) return { job: prepared.job, draft: prepared.draft };
    const job = prepared.job;
    const outline = job.outlines.find((o) => o.id === body.outlineId)!;
    try {
      const generate = await trainingModel(request, 'scene-content:slide');
      const content = await generateSceneContent(
        outline,
        (system, prompt) => generate(system, prompt),
        {
          languageDirective:
            '使用中文，确保数学符号正确。只制作课堂展示内容，不加入教师讲稿和隐藏答案。',
        },
      );
      if (!content || !('elements' in content) || !content.elements.length)
        throw new Error('课件内容为空');
      const canvas = cleanSlide({
        id: outline.id,
        elements: content.elements,
        background: content.background ?? { type: 'solid', color: '#ffffff' },
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: defaultTheme,
      });
      return await this.store.update(this.ownerId, (current) => {
        const saved = find(current.preparations!, jobId);
        const target = find(current.drafts, job.projectId);
        if (request.signal.aborted || saved.inFlight?.token !== token)
          throw new TrainingError('PREPARATION_CANCELLED', '当前页面生成已取消。', 409);
        delete saved.inFlight;
        if (saved.completed.includes(body.outlineId)) return { job: saved, draft: target };
        expectRevision(target.revision, job.revision);
        target.content.pages ??= [];
        target.content.pages.push({
          id: outline.id,
          title: outline.title,
          canvas,
          source: 'generated',
        });
        target.revision++;
        saved.revision = target.revision;
        saved.completed.push(outline.id);
        saved.status = saved.completed.length === saved.outlines.length ? 'complete' : 'running';
        delete saved.error;
        return { job: saved, draft: target };
      });
    } catch (error) {
      await this.store.update(this.ownerId, (current) => {
        const saved = find(current.preparations!, jobId);
        if (saved.inFlight?.token === token) delete saved.inFlight;
        if (!saved.completed.includes(body.outlineId)) {
          saved.status = saved.completed.length ? 'partial' : 'failed';
          saved.error = '页面生成未完成，已成功的页面保留。';
        }
      });
      if (error instanceof TrainingError) throw error;
      throw new TrainingError(
        'PREPARATION_FAILED',
        '本页生成失败，已成功的页面已保存。可重试剩余页面。',
        502,
      );
    }
  }
}
