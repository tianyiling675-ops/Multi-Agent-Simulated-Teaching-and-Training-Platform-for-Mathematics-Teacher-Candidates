'use client';
import { useState } from 'react';
import { ArrowRight, Check, Clock3, Plus, Save } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { MaterialContent } from '@/lib/teacher-training/contracts';
import { applyDocumentImport } from '@/lib/teacher-training/document-import';
import { trainingDate } from '@/lib/teacher-training/class-form';
import type { PreparationSection } from '@/lib/teacher-training/navigation';
import { CoursewarePanel } from './courseware-panel';
import { DocumentImporter } from './document-importer';
import { DocumentSources } from './document-sources';
import type { useTrainingWorkspace } from './use-training-workspace';
import styles from './workbench.module.css';

const fields: {
  key: keyof Pick<
    MaterialContent,
    'objectives' | 'priorKnowledge' | 'keyPoints' | 'process' | 'exercises' | 'notes'
  >;
  label: string;
  hint: string;
}[] = [
  { key: 'objectives', label: '教学目标', hint: '这节课希望学生能解释、判断或完成什么？' },
  {
    key: 'priorKnowledge',
    label: '前置知识与学情',
    hint: '学生已经学过什么？理解本课需要哪些基础？',
  },
  { key: 'keyPoints', label: '重点与难点', hint: '核心概念、容易混淆的关系，以及准备如何突破。' },
  { key: 'process', label: '教学过程', hint: '写下讲解顺序、关键提问、例子和理解检查。' },
  { key: 'exercises', label: '练习与理解检查', hint: '用重述、举例或一道变式题检查学生是否理解。' },
  { key: 'notes', label: '教师备注', hint: '仅供自己备课使用的答案与讲授提示。' },
];

export function PreparationWorkspace({
  workspace: w,
  hidden,
}: {
  workspace: ReturnType<typeof useTrainingWorkspace>;
  hidden: boolean;
}) {
  const [versions, setVersions] = useState(false);
  const { detail, content, setContent, navigation, busy } = w;
  if (!detail) return null;
  // Keep all preparation panes mounted: navigation must not erase outline drafts or undo history.
  const section = w.preparationLocation.section;
  const page =
    content.pages?.find((p) => p.id === w.preparationLocation.pageId) ?? content.pages?.[0];
  function choose(value: PreparationSection) {
    if (!detail) return;
    navigation.navigate({
      view: 'project',
      projectId: detail.project.id,
      tab: 'preparation',
      section: value,
      ...(page ? { pageId: page.id } : {}),
    });
  }
  return (
    <section className={styles.preparationWorkspace} hidden={hidden} aria-label="材料准备工作台">
      <div className={styles.preparationTabs}>
        <nav aria-label="材料分类">
          {(
            [
              ['lesson', '教学设计'],
              ['slides', '课件与练习'],
              ['sources', '参考材料'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              disabled={!!busy}
              aria-pressed={section === value}
              onClick={() => choose(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className={styles.saveIndicator}>
          <Check size={15} />
          {w.dirty ? '有未保存修改' : '草稿已保存'}
          <button disabled={!!busy} onClick={() => setVersions(true)}>
            <Clock3 size={15} />
            历史版本
          </button>
        </div>
      </div>
      <div className={styles.lessonPane} hidden={section !== 'lesson'}>
        <div className={styles.sectionTitle}>
          <h2>教学设计</h2>
          <DocumentImporter
            purpose="lesson_plan"
            disabled={!!busy}
            processLength={content.process.length}
            onBusyChange={w.setDocumentBusy}
            onApply={(document, edited, mode) => {
              setContent(applyDocumentImport(content, document, edited, 'lesson_plan', mode));
              w.setNotice('教案已应用到草稿，请保存或确认试讲版本。');
            }}
          />
        </div>
        <div className={styles.lessonFields}>
          {fields.map((field) => (
            <label
              key={field.key}
              className={
                field.key === 'process' || field.key === 'notes' ? styles.fullWidth : undefined
              }
            >
              {field.label}
              <textarea
                aria-label={field.label}
                value={content[field.key]}
                rows={field.key === 'process' ? 8 : 3}
                maxLength={30000}
                placeholder={field.hint}
                disabled={!!busy}
                onChange={(e) => setContent({ ...content, [field.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div className={styles.sectionTitle}>
          <h2>计划教学环节</h2>
          <button
            disabled={!!busy || content.segments.length >= 40}
            onClick={() =>
              setContent({
                ...content,
                segments: [...content.segments, { id: crypto.randomUUID(), title: '', goal: '' }],
              })
            }
          >
            <Plus size={15} />
            添加环节
          </button>
        </div>
        <p className={styles.muted}>用于备课安排，课堂中可自由调整；不会当作已经发生的教学。</p>
        {content.segments.map((segment, index) => (
          <div key={segment.id} className={styles.segment}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <label>
              环节名称
              <input
                value={segment.title}
                maxLength={200}
                disabled={!!busy}
                onChange={(e) =>
                  setContent({
                    ...content,
                    segments: content.segments.map((s) =>
                      s.id === segment.id ? { ...s, title: e.target.value } : s,
                    ),
                  })
                }
              />
            </label>
            <label>
              环节目标
              <input
                value={segment.goal}
                maxLength={1000}
                disabled={!!busy}
                onChange={(e) =>
                  setContent({
                    ...content,
                    segments: content.segments.map((s) =>
                      s.id === segment.id ? { ...s, goal: e.target.value } : s,
                    ),
                  })
                }
              />
            </label>
            <button
              disabled={!!busy}
              onClick={() =>
                setContent({
                  ...content,
                  segments: content.segments.filter((s) => s.id !== segment.id),
                })
              }
            >
              移除
            </button>
          </div>
        ))}
      </div>
      <div className={styles.preparationColumns} hidden={section !== 'slides'}>
        <CoursewarePanel
          key={detail.project.id}
          projectId={detail.project.id}
          content={content}
          draftDirty={w.dirty}
          disabled={!!busy}
          jobs={detail.preparations ?? []}
          onChange={setContent}
          onSave={w.saveMaterial}
          onSaved={w.materialSaved}
          onBusyChange={w.setDocumentBusy}
          onOutlineDirtyChange={w.setOutlineDirty}
          selectedPageId={page?.id}
          onSelectPage={w.selectPreparationPage}
        />
        <aside className={styles.teacherNotes}>
          <h3>本页教学提示</h3>
          <span className={styles.chip}>仅教师可见</span>
          {page ? (
            <label>
              讲解与提问提示
              <textarea
                rows={7}
                maxLength={5000}
                disabled={!!busy}
                placeholder="记下这一页的关键提问、讲解顺序或易混淆点。"
                value={page.teacherNotes ?? ''}
                onChange={(e) =>
                  setContent({
                    ...content,
                    pages: content.pages?.map((p) =>
                      p.id === page.id ? { ...p, teacherNotes: e.target.value } : p,
                    ),
                  })
                }
              />
            </label>
          ) : (
            <p className={styles.muted}>添加或导入课件后，可为每一页保存提示。</p>
          )}
          <details open>
            <summary>本课重点与难点</summary>
            <p className={styles.prewrap}>{content.keyPoints || '在教学设计中补充重点与难点。'}</p>
          </details>
          <details>
            <summary>关联教案</summary>
            <p className={styles.prewrap}>{content.process || '尚未填写教学过程。'}</p>
          </details>
          <details>
            <summary>教学目标</summary>
            <p className={styles.prewrap}>{content.objectives || '尚未填写教学目标。'}</p>
          </details>
        </aside>
      </div>
      <div className={styles.lessonPane} hidden={section !== 'sources'}>
        <div className={styles.sectionTitle}>
          <h2>参考材料与原始来源</h2>
          <DocumentImporter
            purpose="reference"
            disabled={!!busy}
            onBusyChange={w.setDocumentBusy}
            onApply={(document, edited) => {
              setContent(applyDocumentImport(content, document, edited, 'reference'));
              w.setNotice('参考文档已加入草稿，保存后可用于备课。');
            }}
          />
        </div>
        <p className={styles.muted}>
          教案、参考文档和原课件分别留存。查看或编辑参考正文不会自动改写教学过程。
        </p>
        <DocumentSources
          content={content}
          disabled={!!busy}
          onChange={setContent}
          onBusyChange={w.setDocumentBusy}
        />
        {!content.sources.length && (
          <div className={styles.empty}>
            <h3>把已有资料带进来</h3>
            <p>Word / PDF 可先预览和核对文字，PPTX 请在“课件与练习”中导入原页。</p>
          </div>
        )}
      </div>
      <div className={styles.preparationActionBar}>
        <span>
          当前编辑：草稿 ·{' '}
          {detail.draft.lastVersionId
            ? `已确认版本：V${detail.materials.find((v) => v.id === detail.draft.lastVersionId)?.number ?? '—'}`
            : '尚未确认试讲版本'}
        </span>
        <button disabled={!!busy || !w.dirty} onClick={w.saveDraft}>
          <Save size={16} />
          保存草稿
        </button>
        <button
          className={styles.primary}
          disabled={!!busy || (!content.process.trim() && !content.pages?.length)}
          onClick={w.confirmMaterial}
        >
          确认试讲版本并继续 <ArrowRight size={16} />
        </button>
      </div>
      <Dialog open={versions} onOpenChange={setVersions}>
        <DialogContent className={styles.versionDialog}>
          <DialogTitle>已确认版本</DialogTitle>
          <DialogDescription>
            已用于试讲的材料保持原样，编辑草稿不会改写历史课堂。
          </DialogDescription>
          {!detail.materials.length && <p>完成教案或课件后，确认第一个版本。</p>}
          {detail.materials.map((version) => (
            <details key={version.id} className={styles.versionItem}>
              <summary>
                V{version.number} · {trainingDate(version.createdAt)} ·{' '}
                {version.content.pages?.length ?? 0} 页
              </summary>
              {fields.map(
                (field) =>
                  version.content[field.key] && (
                    <div key={field.key}>
                      <strong>{field.label}</strong>
                      <p className={styles.prewrap}>{version.content[field.key]}</p>
                    </div>
                  ),
              )}
            </details>
          ))}
        </DialogContent>
      </Dialog>
    </section>
  );
}
