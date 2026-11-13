'use client';
import { useMemo } from 'react';
import type { SessionDetail } from '@/lib/teacher-training/contracts';
import { reviewEvidence } from '@/lib/teacher-training/review-model';
import type { useTeacherClassroomController } from './use-teacher-classroom-controller';
import styles from './classroom.module.css';

export function ClassroomTranscript({
  detail,
  controller,
}: {
  detail: SessionDetail;
  controller: ReturnType<typeof useTeacherClassroomController>;
}) {
  const rows = useMemo(() => reviewEvidence(detail), [detail]);
  const name = (id?: string) =>
    detail.classConfig.students.find((student) => student.id === id)?.name ?? '学生';
  return (
    <aside className={styles.chat}>
      <div className={styles.chatHeader}>
        课堂对话<small>只记录实际公开的内容 · 正式评分待配置</small>
        {controller.newMessages && (
          <button onClick={controller.scrollToLatest}>有新消息 · 回到底部</button>
        )}
      </div>
      <div
        className={styles.messages}
        ref={(node) => controller.attachTranscript(node)}
        onScroll={() => controller.onTranscriptScroll()}
        aria-label="课堂对话记录"
      >
        {rows.map((row) =>
          row.text ? (
            <article
              key={row.id}
              className={styles.message}
              data-actor={row.type === 'teacher_text' ? 'teacher' : 'student'}
            >
              <header>
                <strong>{row.type === 'teacher_text' ? '我 · 教师' : name(row.studentId)}</strong>
                <time>
                  {new Date(row.at).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </header>
              <p>{row.text}</p>
            </article>
          ) : (
            <div key={row.id} className={styles.controlEvent}>
              {row.title}
              {row.studentId ? ` · ${name(row.studentId)}` : ''}
            </div>
          ),
        )}
        {!rows.length && (
          <p className={styles.transcriptEmpty}>
            课堂开始后，你的讲解、学生回答、翻页和板书会保存在这一轮记录里。
          </p>
        )}
      </div>
    </aside>
  );
}
