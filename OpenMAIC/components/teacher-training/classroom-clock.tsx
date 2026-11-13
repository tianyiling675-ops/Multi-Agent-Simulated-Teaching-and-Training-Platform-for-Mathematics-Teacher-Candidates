'use client';
import { useEffect, useState } from 'react';
import type { ClassroomEvent } from '@/lib/teacher-training/contracts';
import { classroomSeconds, formatDuration } from '@/lib/teacher-training/review-model';
import styles from './classroom.module.css';

function useElapsed(events: ClassroomEvent[]) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return classroomSeconds(events, now);
}
export function ClassroomClock({
  events,
  plannedMinutes,
}: {
  events: ClassroomEvent[];
  plannedMinutes: number;
}) {
  const seconds = useElapsed(events);
  return (
    <span className={styles.clock} title="课堂经过时长（不含暂停；离线时间尚未单独校准）">
      <span>已进行 {formatDuration(seconds)}</span>
      <small>计划 {plannedMinutes} 分钟</small>
    </span>
  );
}
export function ClassroomLimitNotice({
  events,
  plannedMinutes,
}: {
  events: ClassroomEvent[];
  plannedMinutes: number;
}) {
  const seconds = useElapsed(events);
  return seconds >= plannedMinutes * 60 ? (
    <div className={styles.notice}>已达到预设时长，你可以继续试讲，或主动结束本轮。</div>
  ) : null;
}
