'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowRight, BookOpen, Clock3, Flag, MessageSquare, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { SessionDetail, TrainingSession } from '@/lib/teacher-training/contracts';
import {
  evidenceScene,
  formatDuration,
  reviewEvidence,
  reviewStatistics,
  type EvidenceRow,
} from '@/lib/teacher-training/review-model';
import { sessionStatusLabels } from '@/lib/teacher-training/class-form';
import {
  reviewFeedback,
  reviewFeedbackLabels,
  reviewRubricVersion,
} from '@/lib/teacher-training/review-rubric';
import styles from './workbench.module.css';
import { trainingApi } from '@/lib/teacher-training/client';
import type { FaceEvidence } from '@/lib/teacher-training/face-evidence';
import { faceReviewClips } from '@/lib/teacher-training/face-review';
import { FaceReviewPanel } from './face-review-panel';
import { RehearsalComparison } from './rehearsal-comparison';

const TrainingSlide = dynamic(
  () => import('./slide-surface').then((module) => module.TrainingSlide),
  { ssr: false },
);
export function SessionReview({
  detail,
  disabled,
  onClassroom,
}: {
  detail: SessionDetail;
  disabled: boolean;
  onClassroom: (id: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'speech' | 'board'>('all');
  const [student, setStudent] = useState('');
  const [controls, setControls] = useState(false);
  const [selected, setSelected] = useState<EvidenceRow>();
  const [material, setMaterial] = useState(false);
  const [rehearsalBusy, setRehearsalBusy] = useState(false);
  const [rehearsalError, setRehearsalError] = useState('');
  const [faceDeletion, setFaceDeletion] = useState(0);
  const rehearsalRequests = useRef(new Map<string, string>());
  const [faceEvidence, setFaceEvidence] = useState<{
    sessionId: string;
    data?: FaceEvidence;
    error?: boolean;
  }>();
  const sessionId = detail.session.id;
  useEffect(() => {
    const controller = new AbortController();
    void trainingApi<FaceEvidence>(`sessions/${sessionId}/face-evidence`, undefined, {
      signal: controller.signal,
    })
      .then((data) => setFaceEvidence({ sessionId, data }))
      .catch(() => {
        if (!controller.signal.aborted) setFaceEvidence({ sessionId, error: true });
      });
    return () => controller.abort();
  }, [sessionId]);
  const face = faceEvidence?.sessionId === sessionId ? faceEvidence.data : undefined;
  const rows = useMemo(() => reviewEvidence(detail), [detail]);
  const clips = useMemo(
    () => (face ? faceReviewClips(detail, rows, face.windows) : []),
    [detail, rows, face],
  );
  const feedback = useMemo(
    () =>
      reviewFeedback(
        detail,
        rows,
        clips.filter((clip) => clip.evidence.usable && clip.anchor).map((clip) => clip.anchor!),
      ),
    [detail, rows, clips],
  );
  const stats = useMemo(() => reviewStatistics(detail), [detail]);
  const scene = useMemo(
    () => (selected ? evidenceScene(detail, selected.lastSeq) : null),
    [detail, selected],
  );
  const visible = rows.filter(
    (row) =>
      (!student || row.studentId === student) &&
      (filter === 'speech'
        ? row.type === 'student_speech' ||
          row.type === 'voice_interrupted' ||
          (row.type === 'teacher_text' && (row.intent !== 'explain' || row.voice))
        : filter === 'board'
          ? ['page_exposure', 'board_operation', 'board_visibility'].includes(row.type)
          : controls || !!row.text || row.type === 'voice_interrupted'),
  );
  const actor = (row: EvidenceRow) =>
    row.studentId
      ? (detail.classConfig.students.find((s) => s.id === row.studentId)?.name ?? '学生')
      : '我 · 教师';
  const canRehearse =
    selected &&
    detail.session.status === 'ended' &&
    ((selected.type === 'student_speech' && selected.studentId && !selected.rehearsalSeed) ||
      (selected.type === 'teacher_text' &&
        (selected.intent === 'question' || selected.intent === 'check')));
  async function rehearse(anchorEventId: string) {
    setRehearsalError('');
    setRehearsalBusy(true);
    const requestId = rehearsalRequests.current.get(anchorEventId) ?? crypto.randomUUID();
    rehearsalRequests.current.set(anchorEventId, requestId);
    try {
      const result = await trainingApi<TrainingSession>(`sessions/${sessionId}/rehearsals`, {
        anchorEventId,
        clientRequestId: requestId,
      });
      onClassroom(result.id);
    } catch (failure) {
      setRehearsalError((failure as Error).message);
    } finally {
      setRehearsalBusy(false);
    }
  }
  return (
    <section className={styles.review}>
      <div className={styles.sectionTitle}>
        <div>
          <h2 className={styles.editorialTitle}>回到值得打磨的那个瞬间</h2>
          <p className={styles.subtitle}>
            材料 V{detail.material.number} · {detail.session.rehearsal ? '片段重练' : '独立试讲'} ·{' '}
            {detail.classConfig.students.length} 位虚拟学生
          </p>
        </div>
        <button disabled={disabled} onClick={() => onClassroom(detail.session.id)}>
          {detail.session.status === 'ended' ? '查看课堂现场' : '进入／恢复课堂'}
          <ArrowRight size={15} />
        </button>
      </div>
      <div className={styles.reviewStats}>
        <div>
          <Flag size={22} />
          <span>
            本轮状态<strong>{sessionStatusLabels[detail.session.status]}</strong>
          </span>
        </div>
        <div>
          <Clock3 size={22} />
          <span>
            课堂计时<strong>{formatDuration(stats.seconds)}</strong>
          </span>
        </div>
        <div>
          <MessageSquare size={22} />
          <span>
            全班提问<strong>{stats.questions} 次</strong>
          </span>
        </div>
        <div>
          <Search size={22} />
          <span>
            理解检查<strong>{stats.checks} 次</strong>
          </span>
        </div>
      </div>
      <p className={styles.reviewNotice}>
        试讲复盘仅提供过程反馈。课堂计时扣除暂停，离线时段尚未单独校准。
      </p>
      <div className={styles.reviewColumns}>
        <section className={styles.evidencePanel}>
          <h3>课堂过程与证据</h3>
          <div className={styles.evidenceFilters}>
            {(
              [
                ['all', '全部记录'],
                ['speech', '提问与回答'],
                ['board', '板书与翻页'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className={styles.filterOptions}>
            <label>
              学生
              <select
                aria-label="筛选学生记录"
                value={student}
                onChange={(e) => setStudent(e.target.value)}
              >
                <option value="">全部学生与教师</option>
                {detail.classConfig.students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {filter === 'all' && (
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={controls}
                  onChange={(e) => setControls(e.target.checked)}
                />
                显示课堂操作
              </label>
            )}
          </div>
          <div className={styles.timeline} aria-label="课堂事件记录">
            {!visible.length && (
              <div className={styles.empty}>
                <BookOpen size={25} />
                <p>
                  {detail.events.length
                    ? '当前筛选下没有记录。'
                    : '开始课堂后，这里按发生顺序保存记录。'}
                </p>
              </div>
            )}
            {visible.map((row) => (
              <article key={row.id} className={styles.evidenceRow}>
                <time>
                  {formatDuration(row.seconds)}
                  {row.pageId && (
                    <small>
                      第{' '}
                      {(detail.material.content.pages?.findIndex((p) => p.id === row.pageId) ??
                        -1) + 1}{' '}
                      页
                    </small>
                  )}
                </time>
                <div className={styles.evidenceCard}>
                  <span className={styles.chip}>{row.text ? '文字记录' : '课堂操作'}</span>
                  <h4>
                    {row.intent === 'question'
                      ? '全班提问'
                      : row.intent === 'check'
                        ? '理解检查'
                        : row.title}
                  </h4>
                  {row.text && (
                    <>
                      <span className={styles.muted}>{actor(row)}</span>
                      <p className={styles.prewrap}>{row.text}</p>
                    </>
                  )}
                  {row.type === 'voice_interrupted' && row.voice?.playedMs !== undefined && (
                    <p>打断前约播放 {(row.voice.playedMs / 1000).toFixed(1)} 秒。</p>
                  )}
                  <button className={styles.textButton} onClick={() => setSelected(row)}>
                    查看课堂片段 →
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
        <aside className={styles.reflectionPanel}>
          {detail.session.rehearsal && (
            <RehearsalComparison
              key={`${sessionId}:${faceDeletion}`}
              sessionId={sessionId}
              projectId={detail.session.projectId}
              sourceId={detail.session.rehearsal.sourceSessionId}
            />
          )}
          {face && (
            <FaceReviewPanel
              key={sessionId}
              sessionId={sessionId}
              evidence={face}
              clips={clips}
              onScene={setSelected}
              onClear={() => {
                setFaceEvidence({ sessionId });
                setFaceDeletion((previous) => previous + 1);
              }}
            />
          )}
          {faceEvidence?.sessionId === sessionId && faceEvidence.error && (
            <p className={styles.muted} role="status">
              表情证据暂未加载，可刷新重试。
            </p>
          )}
          <section>
            <h3>试讲评价与反馈</h3>
            <p className={styles.muted}>
              量表 v{reviewRubricVersion} ·{' '}
              {detail.session.status === 'ended' ? '本轮记录' : '截至当前记录'} · 总分与等级暂缓发布
            </p>
            {feedback.map((dimension) => (
              <details key={dimension.title} className={styles.reviewDimension}>
                <summary>
                  <strong>{dimension.title}</strong>
                  <span>权重 {dimension.weight}</span>
                </summary>
                <ul>
                  {dimension.items.map((item) => (
                    <li key={item.id}>
                      <div className={styles.reviewItemHeading}>
                        <h4>{item.title}</h4>
                        <span className={styles.chip}>{reviewFeedbackLabels[item.status]}</span>
                      </div>
                      <p className={styles.muted}>
                        观测点权重 {item.weight} · {item.criterion}
                      </p>
                      <p>{item.note}</p>
                      {(item.rows.length > 0 || item.material) && (
                        <div className={styles.reviewEvidenceLinks}>
                          {item.material && (
                            <button
                              className={styles.textButton}
                              type="button"
                              onClick={() => setMaterial(true)}
                            >
                              对照冻结教案
                            </button>
                          )}
                          {item.rows.map((row) => (
                            <button
                              className={styles.textButton}
                              key={row.id}
                              type="button"
                              onClick={() => setSelected(row)}
                            >
                              {formatDuration(row.seconds)} {row.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </section>
          <section>
            <h3>本轮使用的材料</h3>
            <p>材料 V{detail.material.number} · 已确认</p>
            <button onClick={() => setMaterial(true)}>
              查看版本 <ArrowRight size={15} />
            </button>
          </section>
        </aside>
      </div>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent className={styles.evidenceDialog}>
          <DialogTitle>课堂片段 · {selected ? formatDuration(selected.seconds) : ''}</DialogTitle>
          <DialogDescription>
            来自本轮冻结材料与截至该事件的记录，仅供查看，不会恢复课堂或生成学生回答。
          </DialogDescription>
          {selected?.text && (
            <blockquote className={styles.evidenceQuote}>{selected.text}</blockquote>
          )}
          {selected?.type === 'voice_interrupted' && selected.voice?.playedMs !== undefined && (
            <p>打断前约播放 {(selected.voice.playedMs / 1000).toFixed(1)} 秒。</p>
          )}
          {scene && (
            <div className={styles.evidenceScene}>
              {scene.boardOpen ? (
                <TrainingSlide slide={scene.board} />
              ) : scene.page ? (
                <TrainingSlide slide={scene.page.canvas} />
              ) : (
                <div className={styles.empty}>当时尚未展示课件或打开白板，没有可重建的画面。</div>
              )}
            </div>
          )}
          <p className={styles.muted}>原始证据：{selected?.eventIds.join('、')}</p>
          {canRehearse && selected && (
            <button
              type="button"
              disabled={rehearsalBusy || disabled}
              onClick={() => void rehearse(selected.id)}
            >
              {rehearsalBusy ? '正在准备片段…' : '重练这段'}
            </button>
          )}
          {canRehearse && rehearsalError && <p role="alert">{rehearsalError}</p>}
        </DialogContent>
      </Dialog>
      <Dialog open={material} onOpenChange={setMaterial}>
        <DialogContent className={styles.versionDialog}>
          <DialogTitle>本轮材料 V{detail.material.number}</DialogTitle>
          <DialogDescription>此版本已冻结。当前草稿的新修改不会出现在这里。</DialogDescription>
          {detail.material.content.objectives.trim() && (
            <section>
              <h3>教学目标</h3>
              <p className={styles.prewrap}>{detail.material.content.objectives}</p>
            </section>
          )}
          {detail.material.content.keyPoints.trim() && (
            <section>
              <h3>重点难点</h3>
              <p className={styles.prewrap}>{detail.material.content.keyPoints}</p>
            </section>
          )}
          {detail.material.content.segments.length > 0 && (
            <section>
              <h3>计划环节</h3>
              <ul>
                {detail.material.content.segments.map((segment) => (
                  <li key={segment.id}>
                    {segment.title}
                    {segment.goal && ` · ${segment.goal}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <h3>教学过程</h3>
          <p className={styles.prewrap}>
            {detail.material.content.process || '本轮采用课件或白板试讲。'}
          </p>
          {detail.material.content.pages?.map((page) => (
            <div key={page.id}>
              <h3>{page.title}</h3>
              <div className={styles.materialPreview}>
                <TrainingSlide slide={page.canvas} />
              </div>
            </div>
          ))}
        </DialogContent>
      </Dialog>
    </section>
  );
}
