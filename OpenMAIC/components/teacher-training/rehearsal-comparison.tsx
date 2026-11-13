'use client';

import { useEffect, useState } from 'react';
import { recordsHref, trainingApi } from '@/lib/teacher-training/client';
import { faceActions } from '@/lib/teacher-training/face-evidence';
import type { RehearsalComparison as Comparison } from '@/lib/teacher-training/rehearsal-review';
import styles from './workbench.module.css';

export function RehearsalComparison({
  sessionId,
  projectId,
  sourceId,
}: {
  sessionId: string;
  projectId: string;
  sourceId: string;
}) {
  const [comparison, setComparison] = useState<Comparison>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void trainingApi<Comparison>(`sessions/${sessionId}/rehearsal-comparison`, undefined, {
      signal: controller.signal,
    })
      .then(setComparison)
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [sessionId]);
  return (
    <section aria-label="两次试讲对照">
      <h3>两次试讲对照</h3>
      {error && <p role="alert">暂时无法读取对照记录。</p>}
      {!comparison && !error && <p role="status">正在读取对照记录…</p>}
      {comparison && (
        <div className={styles.rehearsalCompare}>
          {(
            [
              ['原片段', comparison.original],
              ['本次重练', comparison.current],
            ] as const
          ).map(([title, side]) => (
            <div key={title} className={styles.faceReviewClip}>
              <h4>{title}</h4>
              {side ? (
                <>
                  <p>{side.before}</p>
                  <p>{side.after ?? '暂无后续回答或反馈。'}</p>
                  <p className={styles.muted}>
                    {side.observation
                      ? side.observation.map((action) => faceActions[action]).join('、') ||
                        '未标记明显面部动作'
                      : '表情证据不足'}
                  </p>
                  {side.durationMs !== undefined && (
                    <small className={styles.muted}>
                      约 {(side.durationMs / 1000).toFixed(1)} 秒 ·{' '}
                      {side.timing === 'estimated-playback' ? '语音估算' : '记录时间'}
                    </small>
                  )}
                </>
              ) : (
                <p className={styles.muted}>尚无可对照的课堂发言。</p>
              )}
            </div>
          ))}
        </div>
      )}
      <a className={styles.textButton} href={recordsHref(projectId, sourceId)}>
        打开原轮次记录
      </a>
    </section>
  );
}
