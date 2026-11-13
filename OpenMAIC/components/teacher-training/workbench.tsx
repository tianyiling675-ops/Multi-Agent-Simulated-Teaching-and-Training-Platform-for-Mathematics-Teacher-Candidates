'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Clock3,
  FolderOpen,
  Home,
  Loader2,
  Plus,
  Settings,
} from 'lucide-react';
import type { TrainingLocation } from '@/lib/teacher-training/navigation';
import { sessionStatusLabels, trainingDate } from '@/lib/teacher-training/class-form';
import { PRODUCT_NAME, PRODUCT_NAME_LINES } from '@/lib/brand/brand-config';
import { TrainingOverview } from './training-overview';
import { TrainingSettings } from './settings-panel';
import { useTrainingWorkspace } from './use-training-workspace';
import styles from './workbench.module.css';

const PreparationWorkspace = dynamic(
  () => import('./preparation-workspace').then((m) => m.PreparationWorkspace),
  {
    loading: () => <p role="status">正在打开材料编辑区…</p>,
  },
);
const ClassConfiguration = dynamic(() =>
  import('./class-configuration').then((m) => m.ClassConfiguration),
);
const SessionReview = dynamic(() => import('./session-review').then((m) => m.SessionReview));

export function TrainingWorkbench({ initialLocation }: { initialLocation: TrainingLocation }) {
  const w = useTrainingWorkspace(initialLocation);
  const [settings, setSettings] = useState(false);
  const { detail, navigation, busy } = w;
  const location = navigation.location;
  const active =
    location.view === 'home' ? 'home' : location.view === 'history' ? 'history' : 'projects';
  const tab = location.view === 'project' ? location.tab : 'preparation';
  const navigate = navigation.navigate;
  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <BookOpen size={34} strokeWidth={1.5} aria-hidden="true" />
          <strong aria-label={PRODUCT_NAME}>
            {PRODUCT_NAME_LINES.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </strong>
        </div>
        <nav className={styles.globalNav} aria-label="工作台导航">
          {(
            [
              { view: 'home', label: '训练概览', Icon: Home },
              { view: 'projects', label: '我的课题', Icon: FolderOpen },
              { view: 'history', label: '训练记录', Icon: Clock3 },
            ] as const
          ).map(({ view, label, Icon }) => (
            <button
              key={view}
              aria-current={active === view ? 'page' : undefined}
              disabled={!!busy}
              onClick={() => navigate({ view })}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </nav>
        <button
          className={`${styles.primary} ${styles.newButton}`}
          disabled={!!busy}
          onClick={() => navigate({ view: 'new' })}
        >
          <Plus size={17} />
          新建课题
        </button>
        <div className={styles.sidebarTitle}>最近课题</div>
        <nav className={styles.projectList} aria-label="课题列表">
          {w.overview.projects.slice(0, 6).map((project) => (
            <button
              key={project.id}
              disabled={!!busy}
              aria-current={detail?.project.id === project.id ? 'page' : undefined}
              onClick={() =>
                navigate({ view: 'project', projectId: project.id, tab: 'preparation' })
              }
            >
              <strong>{project.title}</strong>
              <span>
                {project.grade} · {project.sessionCount} 轮训练
              </span>
            </button>
          ))}
          {!w.overview.projects.length && (
            <p className={styles.muted}>从一个课题开始，留下你的第一次试讲。</p>
          )}
        </nav>
        <div className={styles.sidebarBottom}>
          <button onClick={() => setSettings(true)}>
            <Settings size={19} />
            模型与设置
          </button>
          <span>
            {w.capability?.storage === 'postgres'
              ? '服务器保存 · 当前设备身份'
              : '本机保存 · 当前浏览器身份'}
          </span>
        </div>
      </aside>
      <section className={styles.main}>
        {location.view === 'project' && (
          <button
            className={styles.back}
            disabled={!!busy}
            onClick={() => navigate({ view: 'home' })}
          >
            <ArrowLeft size={16} />
            返回备课与历史
          </button>
        )}
        {busy && (
          <div className={styles.loading} role="status">
            <Loader2 size={17} className={styles.spin} />
            {busy}
          </div>
        )}
        {w.error && (
          <div className={styles.error} role="alert">
            <span>{w.error}</span>
            <button disabled={!!busy} onClick={w.reload}>
              重新读取状态，保留输入
            </button>
          </div>
        )}
        {w.notice && (
          <div className={styles.notice} role="status">
            <Check size={16} />
            <span>{w.notice}</span>
          </div>
        )}
        {(location.view === 'home' ||
          location.view === 'projects' ||
          location.view === 'history') && (
          <TrainingOverview
            overview={w.overview}
            view={location.view}
            disabled={!!busy}
            onNavigate={navigate}
            onClassroom={w.openClassroom}
          />
        )}
        {location.view === 'new' && (
          <section className={styles.newProjectPage} aria-label="新建备课">
            <div className={styles.pageHeading}>
              <div>
                <span className={styles.eyebrow}>我的课题 / 新建备课</span>
                <h1>准备新的课题</h1>
                <p className={styles.subtitle}>从一个想讲清楚的问题开始。</p>
              </div>
            </div>
            <form
              className={styles.createForm}
              onSubmit={(event) => {
                event.preventDefault();
                w.createProject();
              }}
            >
              <h2>准备一个新的课题</h2>
              <label>
                课题名称
                <input
                  required
                  maxLength={200}
                  value={w.newProject.title}
                  placeholder="例如：椭圆的标准方程"
                  disabled={!!busy}
                  onChange={(e) => w.setNewProject({ ...w.newProject, title: e.target.value })}
                />
              </label>
              <label>
                学段与年级
                <input
                  required
                  maxLength={200}
                  value={w.newProject.grade}
                  placeholder="例如：高中二年级"
                  disabled={!!busy}
                  onChange={(e) => w.setNewProject({ ...w.newProject, grade: e.target.value })}
                />
              </label>
              <label>
                本次教学范围
                <textarea
                  required
                  rows={3}
                  maxLength={2000}
                  value={w.newProject.scope}
                  placeholder="说明这次准备讲清的概念、方法或问题。"
                  disabled={!!busy}
                  onChange={(e) => w.setNewProject({ ...w.newProject, scope: e.target.value })}
                />
              </label>
              <button className={styles.primary} disabled={!!busy || !w.capability} type="submit">
                创建备课 →
              </button>
              <p className={styles.muted}>
                创建后可填写或导入教案、导入 PPTX
                原页，也可以从课题生成可编辑课件。只有教案时，可使用白板试讲。
              </p>
            </form>
          </section>
        )}
        {detail && location.view === 'project' && (
          <>
            <div className={styles.projectHeading}>
              <span className={styles.eyebrow}>我的课题 / {detail.project.title}</span>
              <h1>{detail.project.title}</h1>
              <p className={styles.subtitle}>
                {detail.project.grade} · {detail.project.scope}
              </p>
            </div>
            <nav className={styles.steps} aria-label="训练步骤">
              {(
                [
                  ['preparation', '01', '材料准备'],
                  ['class', '02', '班级配置'],
                  ['classroom', '03', '模拟课堂'],
                  ['records', '04', '训练复盘'],
                ] as const
              ).map(([value, number, label]) => (
                <button
                  key={value}
                  aria-current={tab === value ? 'step' : undefined}
                  disabled={
                    !!busy ||
                    (value === 'classroom' && !detail.sessions.some((s) => s.status !== 'ended'))
                  }
                  onClick={() => {
                    if (value === 'classroom') {
                      const session = detail.sessions.find((s) => s.status !== 'ended');
                      if (session) w.openClassroom(session.id);
                    } else
                      navigate({
                        view: 'project',
                        projectId: detail.project.id,
                        tab: value,
                        ...(value === 'preparation' ? w.preparationLocation : {}),
                        ...(value === 'records' && w.sessionDetail
                          ? { sessionId: w.sessionDetail.session.id }
                          : {}),
                      });
                  }}
                >
                  <span>{number}</span>
                  {label}
                </button>
              ))}
            </nav>
            {w.preparationVisited && (
              <PreparationWorkspace
                key={detail.project.id}
                workspace={w}
                hidden={tab !== 'preparation'}
              />
            )}
            {tab === 'class' && <ClassConfiguration workspace={w} />}
            {tab === 'records' && (
              <div className={styles.records}>
                <div className={styles.sectionTitle}>
                  <h2>课堂记录</h2>
                  <span className={styles.muted}>每一轮都保留自己的材料与过程</span>
                </div>
                <div className={styles.rounds} aria-label="训练轮次">
                  {detail.sessions.map((session, index) => (
                    <button
                      key={session.id}
                      disabled={!!busy}
                      aria-pressed={w.sessionDetail?.session.id === session.id}
                      onClick={() =>
                        navigate({
                          view: 'project',
                          projectId: detail.project.id,
                          tab: 'records',
                          sessionId: session.id,
                        })
                      }
                    >
                      第 {detail.sessions.length - index} 轮
                      <span>
                        {sessionStatusLabels[session.status]} · {trainingDate(session.createdAt)}
                      </span>
                    </button>
                  ))}
                </div>
                {w.sessionDetail ? (
                  <SessionReview
                    key={w.sessionDetail.session.id}
                    detail={w.sessionDetail}
                    disabled={!!busy}
                    onClassroom={w.openClassroom}
                  />
                ) : (
                  <div className={styles.empty}>
                    <BookOpen size={30} />
                    <h3>{detail.sessions.length ? '选择一轮课堂记录' : '还没有试讲记录'}</h3>
                    <p>先确认材料，再到“班级配置”准备课堂。</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <footer className={styles.footer}>
          当前身份随此浏览器保存。清除 Cookie 后无法直接找回原记录，跨设备账号尚未接入。
        </footer>
      </section>
      <TrainingSettings open={settings} onOpenChange={setSettings} />
    </main>
  );
}
