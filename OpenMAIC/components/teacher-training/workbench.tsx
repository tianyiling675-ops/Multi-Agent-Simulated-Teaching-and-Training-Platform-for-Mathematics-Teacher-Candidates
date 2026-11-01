'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, Loader2, Plus, Save } from 'lucide-react';
import type {
  MaterialContent,
  ProjectDetail,
  SessionDetail,
  Student,
  TrainingProject,
  TrainingSession,
} from '@/lib/teacher-training/contracts';
import { emptyMaterial, serializeMaterial } from '@/lib/teacher-training/contracts';
import { parseTrainingLocation, type TrainingLocation } from '@/lib/teacher-training/navigation';
import { useTrainingNavigation } from './use-training-navigation';
import styles from './workbench.module.css';
import { CoursewarePanel } from './courseware-panel';
import { classroomHref } from '@/lib/teacher-training/client';
import { DocumentImporter } from './document-importer';
import { DocumentSources } from './document-sources';
import { applyDocumentImport } from '@/lib/teacher-training/document-import';

type ProjectItem = TrainingProject & { versionCount: number; sessionCount: number };
type Capability = { storage: string; identity: string; phase: string };
type Template = 'strong' | 'mixed' | 'support';
const templates: { id: Template; title: string; description: string }[] = [
  { id: 'strong', title: '基础较好', description: '练习讲解逻辑与深入追问' },
  { id: 'mixed', title: '水平混合', description: '练习分层提问与兼顾差异' },
  { id: 'support', title: '基础薄弱', description: '练习分步解释与困难突破' },
];
const statusLabels: Record<TrainingSession['status'], string> = {
  ready: '准备完成',
  running: '进行中',
  paused: '已暂停',
  interrupted: '已中断',
  ended: '已结束',
};
const eventLabels: Record<string, string> = {
  start: '开始课堂',
  pause: '暂停课堂',
  resume: '继续课堂',
  recover: '恢复至暂停',
  interrupt: '收回发言权',
  call_on: '点名',
  end: '结束课堂',
  teacher_text: '教师发言',
  student_speech: '学生回答',
  page_exposure: '展示课件',
  board_operation: '更新白板',
  board_visibility: '切换白板',
};
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

function initialStudents(template: Template): Student[] {
  return ['小林', '小周', '小陈'].map((name, i) => ({
    id: `student_${i + 1}`,
    name,
    priorKnowledge:
      template === 'strong'
        ? '前置知识较熟悉，仍需检查具体理解。'
        : template === 'support'
          ? '需要具体例子和分步支持。'
          : ['前置知识较熟悉。', '能完成基础问题，解释关系时需要支持。', '部分前置概念仍需澄清。'][
              i
            ],
    expression: (['active', 'responsive', 'reserved'] as const)[i],
    misconceptions: [],
  }));
}
async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/teacher-training/${path}`, {
    method: body === undefined ? 'GET' : method,
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '操作失败，请重试。');
  return result.data as T;
}
const key = () => crypto.randomUUID();
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function TrainingWorkbench({ initialLocation }: { initialLocation: TrainingLocation }) {
  const [capability, setCapability] = useState<Capability>();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [detail, setDetail] = useState<ProjectDetail>();
  const [content, setContent] = useState<MaterialContent>(emptyMaterial);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail>();
  const [tab, setTab] = useState<'preparation' | 'class' | 'records'>('preparation');
  const [newProject, setNewProject] = useState({ title: '', grade: '', scope: '' });
  const [template, setTemplate] = useState<Template>('mixed');
  const [students, setStudents] = useState<Student[]>(() => initialStudents('mixed'));
  const [minutes, setMinutes] = useState(15);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [outlineDirty, setOutlineDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const boot = useRef<Promise<{ capabilities: Capability; projects: ProjectItem[] }> | null>(null);
  const actionLock = useRef(false);
  const setDocumentBusy = useCallback((value: boolean) => {
    actionLock.current = value;
    setBusy(value);
  }, []);
  // Keep the exact operation key/payload after uncertain network failures.
  const pendingOperation = useRef<{ signature: string; id: string } | null>(null);
  const dirty = !!detail && serializeMaterial(content) !== serializeMaterial(detail.draft.content);
  const newProjectDirty = Object.values(newProject).some((value) => value.length > 0);
  const navigation = useTrainingNavigation(initialLocation, {
    canLeave: (target) => {
      if (busy || actionLock.current) {
        setNotice('正在读取或保存，请完成后再切换。');
        return false;
      }
      const leavesProject = target.view !== 'project' || target.projectId !== detail?.project.id;
      const losesInput = (dirty && leavesProject) || (newProjectDirty && target.view !== 'new');
      return (
        !losesInput ||
        window.confirm(
          '当前有未保存的教案、课题信息或未提交的发言。确定放弃这些输入并离开？取消可继续编辑。已保存的课堂不会结束。',
        )
      );
    },
    onNavigate: (target) => {
      void run(() => loadLocation(target));
    },
  });

  const operationKey = (input: unknown) => {
    const signature = JSON.stringify(input);
    if (pendingOperation.current?.signature !== signature)
      pendingOperation.current = { signature, id: key() };
    return pendingOperation.current.id;
  };
  async function run(work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      pendingOperation.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  // Bootstrap once using the initial empty view, before actions are enabled.
  const initialLoad = useRef(loadLocation);
  useEffect(() => {
    let active = true;
    boot.current ??= (async () => {
      const capabilities = await api<Capability>('capabilities');
      return { capabilities, projects: await api<ProjectItem[]>('projects') };
    })();
    void boot.current
      .then(async (result) => {
        if (active) {
          setCapability(result.capabilities);
          setProjects(result.projects);
          await initialLoad.current(parseTrainingLocation(window.location.search));
          setBusy(false);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause.message);
          setBusy(false);
          boot.current = null;
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty && !newProjectDirty && !outlineDirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, newProjectDirty, outlineDirty]);

  async function loadLocation(target: TrainingLocation) {
    if (target.view !== 'project') {
      setDetail(undefined);
      setSessionDetail(undefined);
      setContent(emptyMaterial());
      setNewProject({ title: '', grade: '', scope: '' });
      setTab('preparation');
      setProjects(await api<ProjectItem[]>('projects'));
      return;
    }
    const sameProject = detail?.project.id === target.projectId;
    const sameSession = sameProject && sessionDetail?.session.id === target.sessionId;
    if (!sameProject) {
      setDetail(undefined);
      setContent(emptyMaterial());
      setSessionDetail(undefined);
    } else if (target.tab === 'records' && !sameSession) {
      setSessionDetail(undefined);
    }
    setTab(target.tab);
    // Read both before displaying either: a URL must never combine a project
    // with a different project's classroom, even for the same owner.
    const [project, session] = await Promise.all([
      sameProject && detail
        ? Promise.resolve(detail)
        : api<ProjectDetail>(`projects/${target.projectId}`),
      target.sessionId && !sameSession
        ? api<SessionDetail>(`sessions/${target.sessionId}`)
        : Promise.resolve(undefined),
    ]);
    if (session && session.session.projectId !== target.projectId)
      throw new Error('课堂记录不属于此课题，请返回备课与历史重新选择。');
    if (!sameProject) {
      setDetail(project);
      setContent(project.draft.content);
      setSelectedVersion(project.materials[0]?.id ?? '');
      setSessionDetail(undefined);
      setTemplate('mixed');
      setStudents(initialStudents('mixed'));
      setMinutes(15);
    }
    if (session) {
      setSessionDetail(session);
    }
    setNewProject({ title: '', grade: '', scope: '' });
    setTab(target.tab);
  }

  async function openProject(id: string) {
    const next = await api<ProjectDetail>(`projects/${id}`);
    setDetail(next);
    setContent(next.draft.content);
    setSessionDetail(undefined);
    setSelectedVersion(next.materials[0]?.id ?? '');
    setTab('preparation');
    navigation.commit({ view: 'project', projectId: id, tab: 'preparation' }, true);
  }
  async function refreshProject() {
    if (!detail) return;
    const next = await api<ProjectDetail>(`projects/${detail.project.id}`);
    setDetail(next);
    setProjects(await api<ProjectItem[]>('projects'));
  }
  async function save() {
    if (!detail) return;
    const draft = await api<ProjectDetail['draft']>(
      `drafts/${detail.draft.id}`,
      {
        expectedRevision: detail.draft.revision,
        content,
      },
      'PATCH',
    );
    setDetail({ ...detail, draft });
    setContent(draft.content);
    return draft;
  }
  async function openSession(id: string) {
    const next = await api<SessionDetail>(`sessions/${id}`);
    if (next.session.projectId !== detail?.project.id) throw new Error('课堂记录不属于当前课题。');
    setSessionDetail(next);
    setTab('records');
    navigation.commit({
      view: 'project',
      projectId: next.session.projectId,
      tab: 'records',
      sessionId: id,
    });
  }
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          disabled={busy}
          onClick={() => navigation.navigate({ view: 'home' })}
        >
          <ArrowLeft size={16} /> 返回备课与历史
        </button>
        <span className={styles.wordmark}>
          教师训练 <span>／ WORKSPACE</span>
        </span>
        <span className={styles.storage}>
          {capability?.storage === 'postgres'
            ? '服务器保存 · 当前设备身份'
            : '本机保存 · 当前浏览器身份'}
        </span>
      </header>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarTitle}>
            我的备课 <span>{projects.length.toString().padStart(2, '0')}</span>
          </div>
          <button
            className={styles.newButton}
            disabled={busy}
            onClick={() => navigation.navigate({ view: 'new' })}
          >
            <Plus size={16} /> 新建课题
          </button>
          <nav aria-label="课题列表" className={styles.projectList}>
            {projects.map((project) => (
              <button
                key={project.id}
                disabled={busy}
                aria-current={detail?.project.id === project.id ? 'page' : undefined}
                className={
                  detail?.project.id === project.id ? styles.projectActive : styles.project
                }
                onClick={() =>
                  navigation.navigate({
                    view: 'project',
                    projectId: project.id,
                    tab: 'preparation',
                  })
                }
              >
                <strong>{project.title}</strong>
                <span>
                  {project.grade} · {project.versionCount} 个版本 · {project.sessionCount} 轮记录
                </span>
              </button>
            ))}
          </nav>
          {!projects.length && !busy && (
            <p className={styles.muted}>从一个课题开始，保存你的第一份教案。</p>
          )}
          {dirty && <p className={styles.hint}>有未保存输入，离开课题前请保存或提交。</p>}
          <div className={styles.scopeNote}>
            <BookOpen size={19} />
            <p>
              先把课堂准备好。
              <br />
              每一次确认，都保留一个独立版本。
            </p>
          </div>
        </aside>
        <section className={styles.main}>
          <div className={styles.eyebrow}>数学教师 · 备课与试讲</div>
          <div className={styles.titleRow}>
            <div>
              <h1>
                {detail?.project.title ??
                  (navigation.location.view === 'new' ? '准备新的课题' : '备课与历史')}
              </h1>
              <p className={styles.subtitle}>
                {detail
                  ? `${detail.project.grade} · ${detail.project.scope}`
                  : '准备材料，留下真实过程，再回到值得打磨的地方。'}
              </p>
            </div>
            <span className={styles.phase}>课堂工作台</span>
          </div>
          <p className={styles.deliveryNote}>
            准备课件，配置虚拟班级，再进入有白板的独立课堂。学生回应使用你配置的模型；正式评价标准仍待配置。
          </p>
          {busy && (
            <div role="status" className={styles.loading}>
              <Loader2 size={16} className={styles.spin} /> 正在读取或保存…
            </div>
          )}
          {error && (
            <div role="alert" className={styles.error}>
              {error}
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setCapability(await api<Capability>('capabilities'));
                    setProjects(await api<ProjectItem[]>('projects'));
                    if (!detail && navigation.location.view === 'project')
                      await loadLocation(navigation.location);
                    if (detail) {
                      const next = await api<ProjectDetail>(`projects/${detail.project.id}`);
                      setDetail(next);
                    }
                    if (sessionDetail) await openSession(sessionDetail.session.id);
                    setNotice('已读取最新保存状态，当前编辑内容保留。请核对后再次操作。');
                  })
                }
              >
                重新读取状态，保留输入
              </button>
            </div>
          )}
          {notice && (
            <p role="status" className={styles.notice}>
              <Check size={16} />
              {notice}
            </p>
          )}

          {!detail && navigation.location.view !== 'new' && (
            <section className={styles.overview} aria-label="备课与历史">
              <div className={styles.sectionTitle}>
                <h2>从上一次备课继续</h2>
                <span>{projects.length} 个课题</span>
              </div>
              {!projects.length && !busy && (
                <div className={styles.empty}>
                  <BookOpen size={30} />
                  <h3>还没有课题</h3>
                  <p>点击「新建课题」，准备第一份教案。</p>
                </div>
              )}
              <div className={styles.projectCards}>
                {projects.map((project) => (
                  <article key={project.id}>
                    <span className={styles.eyebrow}>{project.grade}</span>
                    <h3>{project.title}</h3>
                    <p>{project.scope}</p>
                    <span className={styles.muted}>
                      {project.versionCount} 个材料版本 · {project.sessionCount} 轮训练记录
                    </span>
                    <div className={styles.cardActions}>
                      <button
                        disabled={busy}
                        onClick={() =>
                          navigation.navigate({
                            view: 'project',
                            projectId: project.id,
                            tab: 'preparation',
                          })
                        }
                      >
                        继续备课 <ArrowRight size={15} />
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          navigation.navigate({
                            view: 'project',
                            projectId: project.id,
                            tab: 'records',
                          })
                        }
                      >
                        查看训练记录
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {!detail && navigation.location.view === 'new' ? (
            <form
              className={styles.createForm}
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const project = await api<TrainingProject>('projects', {
                    ...newProject,
                    clientRequestId: operationKey(newProject),
                  });
                  await openProject(project.id);
                  setProjects(await api<ProjectItem[]>('projects'));
                  setNewProject({ title: '', grade: '', scope: '' });
                });
              }}
            >
              <div className={styles.sectionTitle}>
                <span>01</span>
                <h2>准备一个新的课题</h2>
              </div>
              <label>
                课题名称
                <input
                  required
                  maxLength={200}
                  value={newProject.title}
                  placeholder="例如：椭圆的标准方程"
                  disabled={busy}
                  onChange={(e) => setNewProject({ ...newProject, title: e.target.value })}
                />
              </label>
              <label>
                学段与年级
                <input
                  required
                  maxLength={200}
                  value={newProject.grade}
                  placeholder="例如：高中二年级"
                  disabled={busy}
                  onChange={(e) => setNewProject({ ...newProject, grade: e.target.value })}
                />
              </label>
              <label>
                本次教学范围
                <textarea
                  required
                  rows={3}
                  maxLength={2000}
                  value={newProject.scope}
                  placeholder="说明这一次准备讲清的概念、方法或问题。"
                  disabled={busy}
                  onChange={(e) => setNewProject({ ...newProject, scope: e.target.value })}
                />
              </label>
              <button className={styles.primary} disabled={busy || !capability} type="submit">
                创建备课 <ArrowRight size={16} />
              </button>
              <p className={styles.muted}>
                可以生成可编辑课件、导入 PPTX，或使用 PDF / Word
                作为参考材料。已有教案也可以直接用于白板试讲。
              </p>
            </form>
          ) : detail ? (
            <>
              <nav className={styles.tabs} aria-label="备课步骤">
                {(
                  [
                    ['preparation', '01', '教案与版本'],
                    ['class', '02', '班级与轮次'],
                    ['records', '03', '课堂记录'],
                  ] as const
                ).map(([value, number, label]) => (
                  <button
                    key={value}
                    aria-current={tab === value ? 'step' : undefined}
                    disabled={busy}
                    onClick={() =>
                      navigation.navigate({
                        view: 'project',
                        projectId: detail.project.id,
                        tab: value,
                        ...(value === 'records' && sessionDetail
                          ? { sessionId: sessionDetail.session.id }
                          : {}),
                      })
                    }
                  >
                    <span>{number}</span>
                    {label}
                  </button>
                ))}
              </nav>
              {tab === 'preparation' && (
                <div className={styles.preparation}>
                  <CoursewarePanel
                    key={detail.project.id}
                    projectId={detail.project.id}
                    content={content}
                    draftDirty={dirty}
                    onOutlineDirtyChange={setOutlineDirty}
                    disabled={busy}
                    jobs={detail.preparations ?? []}
                    onChange={setContent}
                    onSave={save}
                    onSaved={(draft) => {
                      setDetail((previous) => (previous ? { ...previous, draft } : previous));
                      setContent(draft.content);
                    }}
                    onBusyChange={(value) => {
                      actionLock.current = value;
                      setBusy(value);
                    }}
                  />
                  <div className={styles.editor}>
                    <div className={styles.editorTop}>
                      <h2>教学设计</h2>
                      <span>{dirty ? '有未保存修改' : '已保存'}</span>
                    </div>
                    <DocumentImporter
                      purpose="lesson_plan"
                      disabled={busy}
                      processLength={content.process.length}
                      onBusyChange={(value) => {
                        actionLock.current = value;
                        setBusy(value);
                      }}
                      onApply={(document, edited, mode) => {
                        const next = applyDocumentImport(
                          content,
                          document,
                          edited,
                          'lesson_plan',
                          mode,
                        );
                        setContent(next);
                        setNotice(
                          '教案已应用到草稿。请保存草稿或确认材料版本，原文件与核对提示会一起保留。',
                        );
                      }}
                    />
                    <DocumentSources
                      content={content}
                      disabled={busy}
                      onChange={setContent}
                      onBusyChange={setDocumentBusy}
                    />
                    {fields.map((field) => (
                      <label key={field.key}>
                        {field.label}
                        <textarea
                          value={content[field.key]}
                          rows={field.key === 'process' ? 9 : 3}
                          maxLength={30_000}
                          placeholder={field.hint}
                          disabled={busy}
                          onChange={(event) =>
                            setContent({ ...content, [field.key]: event.target.value })
                          }
                        />
                      </label>
                    ))}
                    <div className={styles.sectionTitle}>
                      <h2>计划教学环节</h2>
                      <button
                        type="button"
                        disabled={busy || content.segments.length >= 40}
                        onClick={() =>
                          setContent({
                            ...content,
                            segments: [...content.segments, { id: key(), title: '', goal: '' }],
                          })
                        }
                      >
                        <Plus size={14} /> 添加环节
                      </button>
                    </div>
                    <p className={styles.muted}>
                      用于备课安排，课堂中可自由调整；不会当作已经发生的教学。
                    </p>
                    {content.segments.map((segment, index) => (
                      <div className={styles.segment} key={segment.id}>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <label>
                          环节名称
                          <input
                            value={segment.title}
                            maxLength={200}
                            disabled={busy}
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
                            disabled={busy}
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
                          disabled={busy}
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
                    <div className={styles.actions}>
                      <button
                        disabled={busy || !dirty}
                        onClick={() =>
                          void run(async () => {
                            await save();
                            setNotice('草稿已保存。');
                          })
                        }
                      >
                        <Save size={16} /> 保存草稿
                      </button>
                      <button
                        className={styles.primary}
                        disabled={busy || (!content.process.trim() && !content.pages?.length)}
                        onClick={() =>
                          void run(async () => {
                            const draft = await save();
                            if (!draft) return;
                            const version = await api<ProjectDetail['materials'][number]>(
                              `drafts/${draft.id}/confirm`,
                              { expectedRevision: draft.revision },
                            );
                            await refreshProject();
                            setSelectedVersion(version.id);
                            setNotice(`材料版本 V${version.number} 已确认，历史内容将保留。`);
                          })
                        }
                      >
                        确认本轮材料 <Check size={16} />
                      </button>
                    </div>
                  </div>
                  <aside className={styles.versions}>
                    <h3>已确认版本</h3>
                    <p>修改草稿不会改变已经用于课堂的材料。</p>
                    {detail.materials.length === 0 && (
                      <p className={styles.muted}>完成教案后，确认第一个版本。</p>
                    )}
                    {detail.materials.map((version) => (
                      <details key={version.id}>
                        <summary>
                          V{version.number}
                          <span>{date(version.createdAt)}</span>
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
                  </aside>
                </div>
              )}
              {tab === 'class' && (
                <div className={styles.config}>
                  <div className={styles.sectionTitle}>
                    <h2>选择本轮材料</h2>
                  </div>
                  <label>
                    已确认版本
                    <select
                      disabled={busy}
                      value={selectedVersion}
                      onChange={(e) => setSelectedVersion(e.target.value)}
                    >
                      <option value="">请先确认材料版本</option>
                      {detail.materials.map((version) => (
                        <option key={version.id} value={version.id}>
                          V{version.number} · {date(version.createdAt)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {dirty && (
                    <p className={styles.hint}>草稿有未保存内容。本轮仅使用所选的已确认版本。</p>
                  )}
                  <div className={styles.sectionTitle}>
                    <h2>班级初始配置</h2>
                  </div>
                  <div className={styles.templateGrid}>
                    {templates.map((item) => (
                      <button
                        key={item.id}
                        disabled={busy}
                        aria-pressed={template === item.id}
                        onClick={() => {
                          setTemplate(item.id);
                          setStudents(initialStudents(item.id));
                        }}
                      >
                        <strong>{item.title}</strong>
                        <span>{item.description}</span>
                      </button>
                    ))}
                  </div>
                  <p className={styles.muted}>
                    学生会根据本轮画像和实际公开的讲解、课件及板书回应。可配置 1–8
                    位学生；隐藏学情不会展示在独立试讲界面。
                  </p>
                  <label>
                    学生人数
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={students.length}
                      disabled={busy}
                      onChange={(e) => {
                        const count = Math.max(1, Math.min(8, Number(e.target.value) || 1));
                        setStudents(
                          Array.from(
                            { length: count },
                            (_, i) =>
                              students[i] ?? {
                                ...initialStudents(template)[i % 3],
                                id: 'student_' + (i + 1),
                                name: [
                                  '小林',
                                  '小周',
                                  '小陈',
                                  '小许',
                                  '小赵',
                                  '小吴',
                                  '小唐',
                                  '小叶',
                                ][i],
                              },
                          ),
                        );
                      }}
                    />
                  </label>
                  {students.map((student, i) => (
                    <div className={styles.student} key={student.id}>
                      <label>
                        学生名称
                        <input
                          value={student.name}
                          maxLength={200}
                          disabled={busy}
                          onChange={(e) =>
                            setStudents(
                              students.map((s, n) =>
                                n === i ? { ...s, name: e.target.value } : s,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        本课知识基础
                        <input
                          value={student.priorKnowledge}
                          maxLength={2000}
                          disabled={busy}
                          onChange={(e) =>
                            setStudents(
                              students.map((s, n) =>
                                n === i ? { ...s, priorKnowledge: e.target.value } : s,
                              ),
                            )
                          }
                        />
                      </label>
                      <label>
                        表达特点
                        <select
                          value={student.expression}
                          disabled={busy}
                          onChange={(e) =>
                            setStudents(
                              students.map((s, n) =>
                                n === i
                                  ? { ...s, expression: e.target.value as Student['expression'] }
                                  : s,
                              ),
                            )
                          }
                        >
                          <option value="active">主动表达</option>
                          <option value="responsive">愿意回应</option>
                          <option value="reserved">需要鼓励</option>
                        </select>
                      </label>
                      <label style={{ gridColumn: '1 / -1' }}>
                        本课常见误解（每行一条，仅用于学生模拟）
                        <textarea
                          rows={2}
                          value={student.misconceptions.join('\n')}
                          disabled={busy}
                          maxLength={5000}
                          placeholder="例如：认为椭圆的长半轴总沿着横轴"
                          onChange={(e) =>
                            setStudents(
                              students.map((s, n) =>
                                n === i
                                  ? {
                                      ...s,
                                      misconceptions: e.target.value.split('\n').slice(0, 10),
                                    }
                                  : s,
                              ),
                            )
                          }
                        />
                      </label>
                    </div>
                  ))}
                  <label className={styles.duration}>
                    预设时长（分钟）
                    <input
                      type="number"
                      min={1}
                      max={180}
                      value={minutes}
                      disabled={busy}
                      onChange={(e) => setMinutes(Number(e.target.value))}
                    />
                  </label>
                  <p className={styles.muted}>
                    课堂支持课件、白板、文字和语音转写。全班提问后学生先举手，由你点名；暂停、继续和结束均由你控制。
                  </p>
                  <button
                    className={styles.primary}
                    disabled={busy || dirty || !selectedVersion}
                    onClick={() =>
                      void run(async () => {
                        const operation = operationKey({
                          projectId: detail.project.id,
                          selectedVersion,
                          template,
                          students,
                          minutes,
                        });
                        const config = await api<{ id: string }>('class-configs', {
                          projectId: detail.project.id,
                          template,
                          students: students.map((s) => ({
                            ...s,
                            misconceptions: s.misconceptions.map((m) => m.trim()).filter(Boolean),
                          })),
                          clientRequestId: operation,
                        });
                        const session = await api<TrainingSession>('sessions', {
                          projectId: detail.project.id,
                          materialVersionId: selectedVersion,
                          classConfigVersionId: config.id,
                          inputMode: 'mixed',
                          assistance: 'independent',
                          scope: 'full',
                          plannedMinutes: minutes,
                          clientRequestId: operation,
                        });
                        window.location.assign(classroomHref(session.id));
                      })
                    }
                  >
                    准备本轮课堂 <ArrowRight size={16} />
                  </button>
                </div>
              )}
              {tab === 'records' && (
                <div className={styles.records}>
                  <div className={styles.rounds} aria-label="训练轮次">
                    {detail.sessions.map((session, index) => (
                      <button
                        disabled={busy}
                        key={session.id}
                        aria-pressed={sessionDetail?.session.id === session.id}
                        onClick={() =>
                          navigation.navigate({
                            view: 'project',
                            projectId: detail.project.id,
                            tab: 'records',
                            sessionId: session.id,
                          })
                        }
                      >
                        第 {detail.sessions.length - index} 轮{' '}
                        <span>
                          {statusLabels[session.status]} · {date(session.createdAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                  {!sessionDetail && (
                    <div className={styles.empty}>
                      <BookOpen size={30} />
                      <h2>{detail.sessions.length ? '选择一轮课堂记录' : '还没有试讲记录'}</h2>
                      <p>先确认材料，再到「班级与轮次」准备课堂。</p>
                    </div>
                  )}
                  {sessionDetail && (
                    <>
                      <div className={styles.classroomHeader}>
                        <div>
                          <h2>课堂记录</h2>
                          <p>材料 V{sessionDetail.material.number} · 独立试讲</p>
                        </div>
                        <span>{statusLabels[sessionDetail.session.status]}</span>
                      </div>
                      <p className={styles.hint}>
                        这里仅查看已发生的课堂记录，不会自动开始或生成学生回答。
                      </p>
                      <div className={styles.controls}>
                        <button
                          className={styles.primary}
                          disabled={busy || dirty}
                          onClick={() =>
                            window.location.assign(classroomHref(sessionDetail.session.id))
                          }
                        >
                          {sessionDetail.session.status === 'ended'
                            ? '查看课堂现场'
                            : '进入／恢复课堂'}
                        </button>
                      </div>
                      <div className={styles.timeline} aria-label="课堂事件记录">
                        {sessionDetail.events.length === 0 && (
                          <p className={styles.muted}>开始课堂后，这里按发生顺序保存记录。</p>
                        )}
                        {sessionDetail.events.map((event) => (
                          <article key={event.id}>
                            <div className={styles.eventMeta}>
                              <span>{String(event.seq).padStart(2, '0')}</span>
                              <strong>{eventLabels[event.type] ?? event.type}</strong>
                              <time>{date(event.receivedAt)}</time>
                            </div>
                            {event.payload.text && (
                              <p className={styles.prewrap}>{event.payload.text}</p>
                            )}
                          </article>
                        ))}
                      </div>
                      <div className={styles.reportPending}>
                        <strong>正式评分：待配置评价标准</strong>
                        <p>
                          默认完整框架为教学设计 25 分、课件质量 15 分、实际试讲 60
                          分。评价服务接通且细则发布后，才能生成有证据的正式报告。
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          ) : null}
          <footer className={styles.footer}>
            当前身份随此浏览器保存。清除 Cookie 后无法直接找回原记录，跨设备账号尚未接入。
          </footer>
        </section>
      </div>
    </main>
  );
}
