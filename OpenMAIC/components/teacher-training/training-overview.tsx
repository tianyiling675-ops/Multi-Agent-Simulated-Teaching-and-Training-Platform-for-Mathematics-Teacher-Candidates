'use client';
import { useState } from 'react';
import { ArrowRight, BookOpen, Check, Clock3, FileText, Plus, Search } from 'lucide-react';
import type { TrainingOverview as Overview } from '@/lib/teacher-training/overview';
import type { TrainingLocation } from '@/lib/teacher-training/navigation';
import {
  classTemplates,
  sessionStatusLabels,
  trainingDate,
} from '@/lib/teacher-training/class-form';
import styles from './workbench.module.css';

export function TrainingOverview({
  overview,
  view,
  disabled,
  onNavigate,
  onClassroom,
}: {
  overview: Overview;
  view: 'home' | 'projects' | 'history';
  disabled: boolean;
  onNavigate: (location: TrainingLocation) => void;
  onClassroom: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const projects = overview.projects.filter((project) =>
    `${project.title} ${project.grade} ${project.scope}`.toLocaleLowerCase().includes(query),
  );
  const sessions = overview.recentSessions.filter((session) =>
    `${session.title} ${session.grade} ${sessionStatusLabels[session.status]}`
      .toLocaleLowerCase()
      .includes(query),
  );
  const resume = overview.resumeSession;
  const projectLocation = (id: string): TrainingLocation => ({
    view: 'project',
    projectId: id,
    tab: 'preparation',
  });
  return (
    <>
      <div className={styles.pageHeading}>
        <div>
          <span className={styles.eyebrow}>
            工作台 / {view === 'home' ? '训练概览' : view === 'projects' ? '我的课题' : '训练记录'}
          </span>
          <h1>
            {view === 'home'
              ? '让每一次试讲，都有进步'
              : view === 'projects'
                ? '我的课题'
                : '训练记录'}
          </h1>
          <p className={styles.subtitle}>
            {view === 'home'
              ? '继续你的备课与试讲，找到下一次值得打磨的地方。'
              : view === 'projects'
                ? '材料、班级和每一轮练习，都留在同一个课题里。'
                : '回到真实发生的课堂，查看过程与材料版本。'}
          </p>
        </div>
        <button
          className={styles.primary}
          aria-label="创建新课题"
          disabled={disabled}
          onClick={() => onNavigate({ view: 'new' })}
        >
          <Plus size={17} />
          新建课题
        </button>
      </div>
      {view === 'home' && (
        <div className={styles.overviewHero}>
          <section className={styles.resumeCard} aria-label="继续上一次训练">
            <div className={styles.sectionTitle}>
              <h2>{resume ? '继续上一次训练' : '从一个课题开始'}</h2>
              {resume && (
                <span className={styles.status} data-status={resume.status}>
                  第 {resume.round} 轮 · {sessionStatusLabels[resume.status]}
                </span>
              )}
            </div>
            <h3>{resume?.title ?? overview.projects[0]?.title ?? '准备你的第一堂模拟课'}</h3>
            <p className={styles.muted}>
              {resume
                ? `${resume.grade} · 材料 V${resume.materialNumber} · ${classTemplates.find((t) => t.id === resume.template)?.title}班`
                : '准备教学材料，配置虚拟班级，再由你主导试讲。'}
            </p>
            <div className={styles.progress} aria-label="训练流程">
              {['材料准备', '班级配置', '模拟课堂', '训练复盘'].map((label, index) => (
                <div
                  key={label}
                  data-active={!!resume && index === 2}
                  data-complete={!!resume && index < 2}
                >
                  <span>
                    {resume && index < 2 ? <Check size={14} /> : String(index + 1).padStart(2, '0')}
                  </span>
                  <small>{label}</small>
                </div>
              ))}
            </div>
            <div className={styles.cardActions}>
              {resume ? (
                <>
                  <button
                    className={styles.primary}
                    disabled={disabled}
                    onClick={() => onClassroom(resume.id)}
                  >
                    继续课堂 <ArrowRight size={16} />
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => onNavigate(projectLocation(resume.projectId))}
                  >
                    继续备课
                  </button>
                  <button
                    className={styles.textButton}
                    disabled={disabled}
                    onClick={() =>
                      onNavigate({
                        view: 'project',
                        projectId: resume.projectId,
                        tab: 'records',
                        sessionId: resume.id,
                      })
                    }
                  >
                    查看记录 →
                  </button>
                </>
              ) : (
                <button
                  className={styles.primary}
                  aria-label={overview.projects.length ? '继续最近备课' : '新建第一份备课'}
                  disabled={disabled}
                  onClick={() =>
                    onNavigate(
                      overview.projects[0]
                        ? projectLocation(overview.projects[0].id)
                        : { view: 'new' },
                    )
                  }
                >
                  {overview.projects.length ? '继续备课' : '新建第一份备课'}
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
          </section>
          <aside className={styles.startCard}>
            <h2>开始一轮新训练</h2>
            {[
              ['准备教学材料', '导入教案、课件，或从课题生成大纲。'],
              ['配置虚拟班级', '选择学情模板，按需要调整学生。'],
              ['开始模拟试讲', '你来讲解、提问，决定谁来回答。'],
            ].map(([title, description], index) => (
              <div className={styles.startStep} key={title}>
                <span>{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
              </div>
            ))}
            <button
              className={styles.textButton}
              disabled={disabled}
              onClick={() => onNavigate({ view: 'new' })}
            >
              开始准备 <ArrowRight size={16} />
            </button>
          </aside>
        </div>
      )}
      <div className={styles.sectionTitle}>
        <h2>{view === 'history' ? '最近 50 轮训练' : '我的课题'}</h2>
        <label className={styles.search}>
          <Search size={16} />
          <input
            aria-label={view === 'history' ? '搜索最近训练' : '搜索课题'}
            placeholder={
              view === 'history' ? '筛选最近 50 轮的课题、状态…' : '搜索课题、年级或教学范围…'
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {view !== 'history' && (
        <div className={styles.projectCards}>
          {projects.map((project) => (
            <article key={project.id}>
              <div className={styles.projectIcon}>
                <FileText size={26} />
              </div>
              <div className={styles.projectCardBody}>
                <h3>{project.title}</h3>
                <p>
                  {project.grade} · {project.scope}
                </p>
                <div className={styles.chips}>
                  <span>
                    {project.materialNumber ? `材料 V${project.materialNumber}` : '备课中'}
                  </span>
                  <span>{project.sessionCount} 轮训练</span>
                  {project.draftChanged && <span>草稿有更新</span>}
                </div>
              </div>
              <div className={styles.projectCardActions}>
                <button disabled={disabled} onClick={() => onNavigate(projectLocation(project.id))}>
                  继续备课
                </button>
                {project.sessionCount > 0 && (
                  <button
                    className={styles.textButton}
                    disabled={disabled}
                    onClick={() =>
                      onNavigate({ view: 'project', projectId: project.id, tab: 'records' })
                    }
                  >
                    查看训练记录
                  </button>
                )}
              </div>
            </article>
          ))}
          {!projects.length && !disabled && (
            <div className={styles.empty}>
              <BookOpen size={30} />
              <h3>{query ? '没有找到对应课题' : '还没有课题'}</h3>
              <p>{query ? '换一个关键词试试。' : '新建课题，准备你的第一份教案。'}</p>
            </div>
          )}
        </div>
      )}
      {view !== 'projects' && (
        <section className={styles.recentSection} aria-label="最近训练">
          {view === 'home' && (
            <div className={styles.sectionTitle}>
              <h2>最近训练</h2>
              <button className={styles.textButton} onClick={() => onNavigate({ view: 'history' })}>
                查看训练记录 →
              </button>
            </div>
          )}
          {sessions.length ? (
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>课题</th>
                    <th>轮次</th>
                    <th>状态</th>
                    <th>最近活动</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.slice(0, view === 'home' ? 5 : 50).map((session) => (
                    <tr key={session.id}>
                      <td>
                        <strong>{session.title}</strong>
                        <small>
                          {session.grade} · 材料 V{session.materialNumber}
                        </small>
                      </td>
                      <td>第 {session.round} 轮</td>
                      <td>
                        <span className={styles.status} data-status={session.status}>
                          {sessionStatusLabels[session.status]}
                        </span>
                      </td>
                      <td>{trainingDate(session.lastActivityAt)}</td>
                      <td>
                        <button
                          disabled={disabled}
                          onClick={() =>
                            session.status !== 'ended'
                              ? onClassroom(session.id)
                              : onNavigate({
                                  view: 'project',
                                  projectId: session.projectId,
                                  tab: 'records',
                                  sessionId: session.id,
                                })
                          }
                        >
                          {session.status === 'ended' ? '查看记录' : '继续课堂'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.quietEmpty}>
              <Clock3 size={20} />
              <p>{query ? '最近训练中没有匹配记录。' : '试讲开始后，过程记录会出现在这里。'}</p>
            </div>
          )}
        </section>
      )}
    </>
  );
}
