'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Upload,
  Sparkles,
  ChevronUp,
  ChevronDown,
  Trash2,
  Settings,
  Loader2,
} from 'lucide-react';
import type { Slide } from '@openmaic/dsl';
import type * as Importer from '@openmaic/importer';
import type { MaterialContent, PreparationDraft } from '@/lib/teacher-training/contracts';
import type { PreparationJob } from '@/lib/teacher-training/preparation-service';
import { blankSlide } from '@/lib/teacher-training/slides';
import { trainingApi } from '@/lib/teacher-training/client';
import { TrainingSettings } from './settings-panel';
import { TrainingSlide } from './slide-surface';
import dynamic from 'next/dynamic';
import styles from './preparation.module.css';
import { fileDataUrl } from '@/lib/teacher-training/document-import';

const TrainingSlideEditor = dynamic(
  () => import('./slide-editor').then((m) => m.TrainingSlideEditor),
  { ssr: false, loading: () => <p role="status">正在打开课件编辑器…</p> },
);

export function CoursewarePanel({
  projectId,
  content,
  disabled,
  jobs,
  onChange,
  onSave,
  onSaved,
  onBusyChange,
  onOutlineDirtyChange,
  draftDirty,
  selectedPageId,
  onSelectPage,
}: {
  projectId: string;
  content: MaterialContent;
  disabled: boolean;
  jobs: PreparationJob[];
  onChange: (content: MaterialContent) => void;
  onSave: () => Promise<PreparationDraft | undefined>;
  onSaved: (draft: PreparationDraft) => void;
  onBusyChange: (busy: boolean) => void;
  onOutlineDirtyChange: (dirty: boolean) => void;
  draftDirty: boolean;
  selectedPageId?: string;
  onSelectPage?: (id: string) => void;
}) {
  const [selected, setSelected] = useState('');
  const selectPage = (id: string) => {
    setSelected(id);
    onSelectPage?.(id);
  };
  const [editing, setEditing] = useState(false);
  const [outlineEdits, setOutlineEdits] = useState<
    Record<string, { title: string; description: string }>
  >({});
  const [settings, setSettings] = useState(false);
  const [working, setWorking] = useState('');
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState<PreparationJob>();
  useEffect(() => {
    onOutlineDirtyChange(Object.keys(outlineEdits).length > 0);
  }, [outlineEdits, onOutlineDirtyChange]);
  useEffect(() => () => onOutlineDirtyChange(false), [onOutlineDirtyChange]);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const cancelled = useRef(false);
  useEffect(
    () => () => {
      cancelled.current = true;
      controller.current?.abort();
    },
    [],
  );
  const pages = content.pages ?? [];
  const page = pages.find((p) => p.id === (selectedPageId ?? selected)) ?? pages[0];
  const latestJob = job ?? jobs.at(-1);
  const locked = disabled || !!working;
  const busy = (label: string) => {
    setWorking(label);
    onBusyChange(!!label);
  };

  async function importFile(file: File) {
    if (file.size > 8 * 1024 * 1024) {
      setNotice('当前单份文件上限为8 MiB，请压缩或拆分后上传。');
      return;
    }
    if (content.sources.length >= 5) {
      setNotice('当前最多保留5份来源材料。');
      return;
    }
    busy('正在导入材料');
    setNotice('');
    try {
      const format = file.name.split('.').pop()?.toLowerCase();
      const originalData = await fileDataUrl(file);
      if (format === 'pptx') {
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(file);
        const count = Object.keys(zip.files).filter((name) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(name),
        ).length;
        if (!count) throw new Error('没有找到PPTX页面，请检查文件。');
        const available = 80 - pages.length;
        if (available <= 0) throw new Error('当前课件已达到80页。');
        if (
          count > available &&
          !window.confirm(
            `文件共${count}页，本次最多导入前${available}页，后续页面不会导入。是否继续？`,
          )
        )
          return;
        const url = '/vendor/maic-importer/index.js';
        const mod = (await import(
          /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ url
        )) as typeof Importer;
        const slides = (await mod.importPptx(file, {
          upload: async (blob: Blob) => fileDataUrl(blob),
        })) as Slide[];
        const imported = slides.slice(0, available).map((canvas, i) => {
          const id = `page_${crypto.randomUUID()}`;
          return {
            id,
            title: `${file.name.replace(/\.pptx$/i, '')} · ${i + 1}`,
            canvas: { ...canvas, id },
            source: 'uploaded' as const,
          };
        });
        onChange({
          ...content,
          pages: [...pages, ...imported],
          sources: [
            ...content.sources,
            {
              name: file.name,
              format: 'pptx',
              originalText: `原文件${count}页，实际导入${imported.length}页。`,
              originalData,
              purpose: 'courseware',
            },
          ],
        });
        selectPage(imported[0]?.id ?? '');
        setEditing(false);
        setNotice(
          `已导入${imported.length}/${count}页。请预览核对公式、图片和版式，再保存确认。原PPT动画不作为本轮授课脚本。`,
        );
      } else throw new Error('请选择 PPTX 课件；Word／PDF 请使用“导入参考文档”。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入失败，已保存内容保留。');
    } finally {
      busy('');
    }
  }
  async function generate(resume = false) {
    if (resume && draftDirty) {
      setNotice(
        '草稿有未保存修改。请先保存；如修改了生成所依据的草稿，请重新生成大纲，避免覆盖编辑。',
      );
      return;
    }
    cancelled.current = false;
    controller.current = new AbortController();
    setNotice('');
    busy('正在生成大纲');
    try {
      let currentJob = latestJob;
      if (!resume) {
        const draft = await onSave();
        if (!draft) return;
        currentJob = await trainingApi<PreparationJob>(
          `projects/${projectId}/generate`,
          { expectedRevision: draft.revision, clientRequestId: crypto.randomUUID() },
          { model: true, signal: controller.current.signal },
        );
        setJob(currentJob);
        setOutlineEdits({});
        setNotice('大纲已生成。可先核对，再生成课件页面。');
        return;
      }
      if (!currentJob) return;
      if (Object.keys(outlineEdits).length) {
        currentJob = await trainingApi<PreparationJob>(
          `preparations/${currentJob.id}/outline`,
          {
            expectedOutlineRevision: currentJob.outlineRevision ?? 0,
            outlines: currentJob.outlines.map((o) => ({
              id: o.id,
              title: outlineEdits[o.id]?.title ?? o.title,
              description: outlineEdits[o.id]?.description ?? o.description,
              keyPoints: o.keyPoints,
            })),
          },
          { method: 'PATCH' },
        );
        setJob(currentJob);
        setOutlineEdits({});
      }
      for (const outline of currentJob.outlines) {
        if (cancelled.current) break;
        if (currentJob.completed.includes(outline.id)) continue;
        busy(`正在生成课件 ${currentJob.completed.length + 1}/${currentJob.outlines.length}`);
        const result: { job: PreparationJob; draft: PreparationDraft } = await trainingApi<{
          job: PreparationJob;
          draft: PreparationDraft;
        }>(
          `preparations/${currentJob.id}/page`,
          { outlineId: outline.id },
          { model: true, signal: controller.current.signal },
        );
        currentJob = result.job;
        setJob(currentJob);
        onSaved(result.draft);
        selectPage(outline.id);
        setEditing(false);
      }
      setNotice(
        cancelled.current
          ? '生成已停止，已成功的页面保留。'
          : '课件已生成并保存为草稿。请预览、编辑后确认版本。',
      );
    } catch (error) {
      setNotice(
        cancelled.current
          ? '已取消后续生成。已保存页面保留，可重新读取后继续。'
          : error instanceof Error
            ? error.message
            : '生成失败',
      );
    } finally {
      busy('');
      controller.current = null;
    }
  }
  const move = (direction: number) => {
    if (!page) return;
    const next = [...pages];
    const index = next.findIndex((p) => p.id === page.id);
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...content, pages: next });
  };
  return (
    <section className={styles.preparationPanel} aria-label="课件准备">
      <div className={styles.sectionHeading}>
        <div>
          <h2>课件准备</h2>
        </div>
        <button type="button" onClick={() => setSettings(true)}>
          <Settings size={16} />
          模型设置
        </button>
      </div>
      <div className={styles.toolrow}>
        <button type="button" disabled={locked} onClick={() => void generate()}>
          <Sparkles size={16} />
          从课题生成课件
        </button>
        <button type="button" disabled={locked} onClick={() => input.current?.click()}>
          <Upload size={16} />
          导入PPTX课件
        </button>
        <button
          type="button"
          disabled={locked || pages.length >= 80}
          onClick={() => {
            const id = `page_${crypto.randomUUID()}`;
            onChange({
              ...content,
              pages: [
                ...pages,
                {
                  id,
                  title: `新页面 ${pages.length + 1}`,
                  canvas: blankSlide(id),
                  source: 'edited',
                },
              ],
            });
            selectPage(id);
            setEditing(true);
          }}
        >
          <Plus size={16} />
          空白页
        </button>
        <input
          ref={input}
          type="file"
          hidden
          accept=".pptx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importFile(file);
          }}
        />
      </div>
      {working && (
        <div className={styles.notice} role="status">
          <Loader2 size={16} className={styles.spin} />
          {working}
          <button
            hidden={!controller.current}
            onClick={() => {
              cancelled.current = true;
              controller.current?.abort();
            }}
          >
            停止生成
          </button>
        </div>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {latestJob && latestJob.outlines.length > 0 && latestJob.status !== 'complete' && (
        <div className={styles.outline}>
          <strong>
            课件大纲 · 已完成 {latestJob.completed.length}/{latestJob.outlines.length} 页
          </strong>
          <ol>
            {latestJob.outlines.map((o) => (
              <li key={o.id}>
                {latestJob.completed.includes(o.id) ? (
                  o.title + ' ✓'
                ) : (
                  <div>
                    <input
                      aria-label={'大纲标题 ' + o.title}
                      disabled={locked}
                      value={outlineEdits[o.id]?.title ?? o.title}
                      onChange={(e) =>
                        setOutlineEdits({
                          ...outlineEdits,
                          [o.id]: {
                            title: e.target.value,
                            description: outlineEdits[o.id]?.description ?? o.description,
                          },
                        })
                      }
                    />
                    <textarea
                      aria-label={'大纲内容 ' + o.title}
                      disabled={locked}
                      value={outlineEdits[o.id]?.description ?? o.description}
                      onChange={(e) =>
                        setOutlineEdits({
                          ...outlineEdits,
                          [o.id]: {
                            title: outlineEdits[o.id]?.title ?? o.title,
                            description: e.target.value,
                          },
                        })
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
          <button disabled={locked} type="button" onClick={() => void generate(true)}>
            按此大纲生成剩余页面
          </button>
        </div>
      )}
      {page ? (
        <div className={styles.prepDeck}>
          <nav aria-label="课件页面" className={styles.prepRail}>
            {pages.map((p, i) => (
              <button
                type="button"
                key={p.id}
                aria-pressed={page.id === p.id}
                disabled={locked}
                onClick={() => {
                  selectPage(p.id);
                  setEditing(false);
                }}
              >
                <span>
                  {String(i + 1).padStart(2, '0')} · {p.title}
                </span>
                <div className={styles.prepThumbnail} aria-hidden="true">
                  <TrainingSlide slide={p.canvas} />
                </div>
              </button>
            ))}
          </nav>
          <div className={styles.prepStage}>
            <div className={styles.toolrow}>
              <input
                aria-label="页面标题"
                disabled={locked}
                value={page.title}
                onChange={(e) =>
                  onChange({
                    ...content,
                    pages: pages.map((p) =>
                      p.id === page.id ? { ...p, title: e.target.value } : p,
                    ),
                  })
                }
              />
              <button type="button" disabled={locked} onClick={() => setEditing(!editing)}>
                {editing ? '预览' : '编辑页面'}
              </button>
              <button aria-label="页面前移" disabled={locked} onClick={() => move(-1)}>
                <ChevronUp size={16} />
              </button>
              <button aria-label="页面后移" disabled={locked} onClick={() => move(1)}>
                <ChevronDown size={16} />
              </button>
              <button
                aria-label="移除页面"
                disabled={locked}
                onClick={() => {
                  if (window.confirm('从草稿移除此页？已确认版本保持不变。'))
                    onChange({ ...content, pages: pages.filter((p) => p.id !== page.id) });
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div
              className={styles.preview}
              style={locked ? { pointerEvents: 'none', opacity: 0.7 } : undefined}
            >
              {editing ? (
                <TrainingSlideEditor
                  key={page.id}
                  slide={page.canvas}
                  onChange={(canvas) =>
                    onChange({
                      ...content,
                      pages: pages.map((p) =>
                        p.id === page.id ? { ...p, canvas, source: 'edited' } : p,
                      ),
                    })
                  }
                />
              ) : (
                <TrainingSlide slide={page.canvas} />
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.materialEmpty}>
          <BookIcon />
          <strong>把课件带进课堂</strong>
          <p>生成可编辑课件，或保留PPTX页面导入。只有教案时，也可以直接使用白板试讲。</p>
        </div>
      )}
      <TrainingSettings open={settings} onOpenChange={setSettings} />
    </section>
  );
}
function BookIcon() {
  return (
    <div className={styles.paperIcon}>
      Aa <span>∑</span>
    </div>
  );
}
