'use client';

import { useState } from 'react';
import { trainingApi } from '@/lib/teacher-training/client';
import { faceActions, type FaceEvidence } from '@/lib/teacher-training/face-evidence';
import type { FaceReviewClip } from '@/lib/teacher-training/face-review';
import { formatDuration, type EvidenceRow } from '@/lib/teacher-training/review-model';
import styles from './workbench.module.css';

const titles = {
  waiting: '提问与等待',
  response: '学生回答后的教师反馈',
  observation: '表情观测',
} as const;

export function FaceReviewPanel({
  sessionId,
  evidence,
  clips,
  onClear,
  onScene,
}: {
  sessionId: string;
  evidence: FaceEvidence;
  clips: FaceReviewClip[];
  onClear(): void;
  onScene(row: EvidenceRow): void;
}) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState<string>();
  const [suggestions, setSuggestions] = useState<
    Record<string, { question: string; practice: string }>
  >({});
  async function generate(clipId: string) {
    setGenerating(clipId);
    setError('');
    try {
      const result = await trainingApi<{ question: string; practice: string }>(
        `sessions/${sessionId}/face-feedback`,
        { clipId },
        { model: true },
      );
      setSuggestions((previous) => ({ ...previous, [clipId]: result }));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setGenerating(undefined);
    }
  }
  async function clear() {
    if (!window.confirm('删除本轮已保存的表情摘要？')) return;
    setClearing(true);
    setError('');
    try {
      await trainingApi(`sessions/${sessionId}/face-evidence`, undefined, { method: 'DELETE' });
      onClear();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setClearing(false);
    }
  }

  if (!evidence.windows.length) return null;
  return (
    <section className={styles.faceReview} aria-label="本轮表情证据">
      <div className={styles.faceReviewHeading}>
        <h3>表情证据</h3>
        <button
          type="button"
          className={styles.textButton}
          disabled={clearing || !!generating}
          onClick={() => void clear()}
        >
          删除摘要
        </button>
      </div>
      <p className={styles.muted}>
        时间从本轮开始计算。面部动作按约 2 秒的采样窗口与课堂记录对齐。
      </p>
      {clips.some((clip) => clip.evidence.usable) && (
        <p className={styles.muted}>
          生成 AI 建议时会将所选片段的动作摘要和相关发言发送给当前模型。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!clips.length && <p className={styles.muted}>本轮没有可定位的表情片段。</p>}
      {clips.map((clip) => (
        <details key={clip.id} className={styles.faceReviewClip}>
          <summary>
            {formatDuration(Math.floor(clip.offsetMs / 1000))} · {titles[clip.kind]}
          </summary>
          <p className={styles.muted}>
            约 {(clip.durationMs / 1000).toFixed(1)} 秒 ·{' '}
            {clip.timing === 'publication'
              ? '按文字发布与提交时间定位'
              : clip.timing === 'estimated-playback'
                ? '按语音播放与转写时间估算'
                : '按摄像头采样时间定位'}
          </p>
          <p>
            {!clip.evidence.usable
              ? '人脸采样不足。'
              : clip.evidence.actions.length
                ? `观测到${clip.evidence.actions.map((action) => faceActions[action]).join('、')}。`
                : '可用采样中未标记明显的嘴角或眉部变化。'}
          </p>
          <p className={styles.muted}>
            单人脸可用采样 {clip.evidence.visible}／{clip.evidence.samples}
          </p>
          {[clip.anchor, clip.followUp]
            .flatMap((row) => (row ? [row] : []))
            .map((row) => (
              <div className={styles.faceReviewContext} key={row.id}>
                {row.text && <p>{row.text}</p>}
                <button type="button" className={styles.textButton} onClick={() => onScene(row)}>
                  查看{row.title}时的课堂现场
                </button>
              </div>
            ))}
          {clip.evidence.usable && (
            <button
              type="button"
              className={styles.textButton}
              disabled={!!generating || clearing}
              title="将本段动作摘要和相关发言发送给当前配置的 AI 模型"
              onClick={() => void generate(clip.id)}
            >
              {generating === clip.id ? '正在生成建议…' : '生成 AI 复盘建议'}
            </button>
          )}
          {suggestions[clip.id] && (
            <div className={styles.faceReviewContext} aria-live="polite">
              <p>{suggestions[clip.id].question}</p>
              <p>{suggestions[clip.id].practice}</p>
            </div>
          )}
        </details>
      ))}
    </section>
  );
}
