'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Presentation,
  PencilLine,
  Hand,
  Pause,
  Play,
  Square,
  Mic,
  MicOff,
  Send,
  Settings,
  Loader2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { SessionDetail, ClassroomEvent } from '@/lib/teacher-training/contracts';
import type { BoardOperation } from '@/lib/teacher-training/classroom-contracts';
import { trainingApi, recordsHref } from '@/lib/teacher-training/client';
import AgentAvatar from '@/components/agent/agent-avatar';
import { SettingsDialog } from '@/components/settings';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { TrainingSlide } from './slide-surface';
import { TeachingBoard } from './teaching-board';
import styles from './classroom.module.css';

const labels: Record<string, string> = {
  start: '开始课堂',
  pause: '暂停课堂',
  resume: '继续课堂',
  recover: '恢复到暂停',
  interrupt: '教师收回发言',
  call_on: '教师点名',
  end: '结束课堂',
  page_exposure: '展示课件',
  board_visibility: '切换白板',
  board_operation: '更新板书',
};
const statusLabels = {
  ready: '待开始',
  running: '进行中',
  paused: '已暂停',
  interrupted: '已中断',
  ended: '已结束',
};
const colors = [
  '#355f4f',
  '#9a7042',
  '#526c91',
  '#9a6366',
  '#6f7895',
  '#6f8659',
  '#90744d',
  '#5f8c91',
];
type PublicTurn = {
  id: string;
  studentId?: string;
  speakerEpoch: number;
  status: string;
  committedLength: number;
  speech: string;
  hands: string[];
};

function teachingSeconds(events: ClassroomEvent[], now: number) {
  let total = 0,
    started = 0;
  for (const e of events) {
    const at = Date.parse(e.receivedAt);
    if (e.type === 'start' || e.type === 'resume') {
      if (!started) started = at;
    }
    if (['pause', 'recover', 'end'].includes(e.type) && started) {
      total += at - started;
      started = 0;
    }
  }
  return Math.max(0, Math.floor((total + (started ? now - started : 0)) / 1000));
}

export function TeacherClassroom({ sessionId }: { sessionId: string }) {
  const [detail, setDetail] = useState<SessionDetail>();
  const current = useRef<SessionDetail | undefined>(undefined);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [speech, setSpeech] = useState('');
  const [speechInput, setSpeechInput] = useState<'text' | 'asr'>('text');
  const allowLeave = useRef(false);
  const [intent, setIntent] = useState<'explain' | 'question' | 'check'>('explain');
  const [saving, setSaving] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [recover, setRecover] = useState(false);
  const [settings, setSettings] = useState(false);
  const [ending, setEnding] = useState(false);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [voiceAccepted, setVoiceAccepted] = useState(false);
  const [boardDirty, setBoardDirty] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [retryTrigger, setRetryTrigger] = useState<string>();
  const [activeSpeaker, setActiveSpeaker] = useState<string>();
  const generation = useRef<AbortController | null>(null);
  const publication = useRef(0);
  const reactionRequests = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(new Map<string, { id: string; payload: Record<string, unknown> }>());
  const messages = useRef<HTMLDivElement>(null);
  const canWrite = !!detail && detail.session.status === 'running' && !recover;
  const canWriteRef = useRef(false);
  useEffect(() => {
    canWriteRef.current = canWrite;
  }, [canWrite]);
  const load = useCallback(
    async (initial = false) => {
      const previous = current.current;
      const next: SessionDetail =
        initial || !previous
          ? await trainingApi<SessionDetail>(`sessions/${sessionId}`)
          : {
              ...previous,
              ...(await trainingApi<Pick<SessionDetail, 'session' | 'events' | 'classroom'>>(
                `sessions/${sessionId}/runtime`,
              )),
            };
      if (current.current && next.session.revision < current.current.session.revision)
        return current.current;
      if (!mounted.current) return next;
      current.current = next;
      setDetail(next);
      if (initial)
        setRecover(next.session.status === 'running' || next.session.status === 'interrupted');
      return next;
    },
    [sessionId],
  );
  const stopLocal = useCallback(() => {
    publication.current++;
    generation.current?.abort();
    generation.current = null;
    window.speechSynthesis?.cancel();
    setThinking(false);
    setActiveSpeaker(undefined);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load(true).catch((e) => setError(e.message));
    const publicationRef = publication;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      generation.current?.abort();
      publicationRef.current++;
      window.speechSynthesis?.cancel();
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    messages.current?.scrollTo({ top: messages.current.scrollHeight, behavior: 'smooth' });
  }, [detail?.events.length]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!allowLeave.current && (speech.trim() || boardDirty || saving)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [speech, boardDirty, saving]);

  // Serialize short writes, never hold this queue while a model is thinking.
  function mutate(path: 'commands' | 'events', body: Record<string, unknown>) {
    const action = async () => {
      if (!current.current) throw new Error('课堂尚未加载');
      setSaving(true);
      setError('');
      const signature = JSON.stringify({ path, body });
      let operation = pending.current.get(signature);
      if (!operation) {
        operation = {
          id: crypto.randomUUID(),
          payload: { ...body, expectedRevision: current.current.session.revision },
        };
        pending.current.set(signature, operation);
      }
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await trainingApi<{ event: ClassroomEvent }>(
              `sessions/${sessionId}/${path}`,
              { ...operation.payload, clientEventId: operation.id },
            );
            pending.current.delete(signature);
            await load();
            return response.event;
          } catch (e) {
            const err = e as Error & { code?: string };
            if (err.code !== 'VERSION_CONFLICT') throw e;
            pending.current.delete(signature);
            const latest = await load();
            if (path !== 'commands' || attempt === 2) throw e;
            operation = {
              id: crypto.randomUUID(),
              payload: { ...body, expectedRevision: latest.session.revision },
            };
            pending.current.set(signature, operation);
          }
        }
        throw new Error('课堂状态持续更新，请重试控制操作。');
      } catch (e) {
        setError(e instanceof Error ? e.message : '操作失败');
        throw e;
      } finally {
        setSaving(false);
      }
    };
    const task = queue.current.catch(() => {}).then(action);
    queue.current = task;
    return task;
  }

  const recorder = useAudioRecorder({
    continuous: true,
    onTranscription: (text) => {
      if (!canWriteRef.current) return;
      // Recognition is a draft until the teacher submits it, so a pause or an
      // ASR chunk boundary never yields the floor to students.
      setSpeechInput('asr');
      setSpeech((previous) => `${previous}${previous ? '\n' : ''}${text}`);
      setNotice('语音已转为待提交文字，请核对后发送。当前记录文字，不将未归档录音标为已保存。');
    },
    onError: (message) => setError(message),
  });
  const cancelRecording = recorder.cancelRecording;
  useEffect(() => () => cancelRecording(), [cancelRecording]);

  async function react(triggerId: string) {
    generation.current?.abort();
    const controller = new AbortController();
    generation.current = controller;
    const token = ++publication.current;
    setThinking(true);
    setRetryTrigger(undefined);
    setError('');
    let requestId = reactionRequests.current.get(triggerId);
    if (!requestId) {
      requestId = crypto.randomUUID();
      reactionRequests.current.set(triggerId, requestId);
    }
    try {
      const turn = await trainingApi<PublicTurn>(
        `sessions/${sessionId}/react`,
        { triggerId, clientRequestId: requestId },
        { model: true, signal: controller.signal },
      );
      if (token !== publication.current || controller.signal.aborted) return;
      if (turn.studentId) {
        // Each published sentence is visible text and therefore valid public
        // evidence, independent of optional browser read-aloud completion.
        const parts = turn.speech.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g) ?? [
          turn.speech,
        ];
        let length = 0;
        setActiveSpeaker(turn.studentId);
        for (const part of parts) {
          if (token !== publication.current || controller.signal.aborted) return;
          length += part.length;
          if (length <= turn.committedLength) continue;
          await trainingApi(
            `sessions/${sessionId}/deliver`,
            {
              turnId: turn.id,
              speakerEpoch: turn.speakerEpoch,
              clientEventId: `${turn.id}_${length}`,
              length,
            },
            { signal: controller.signal },
          );
          if (token !== publication.current) return;
          await load();
          if (audioEnabled && 'speechSynthesis' in window) {
            await new Promise<void>((resolve) => {
              const utterance = new SpeechSynthesisUtterance(part);
              utterance.lang = 'zh-CN';
              utterance.onend = () => resolve();
              utterance.onerror = () => resolve();
              controller.signal.addEventListener('abort', () => resolve(), { once: true });
              window.speechSynthesis.speak(utterance);
            });
          }
        }
        setActiveSpeaker(undefined);
      } else {
        await load();
        setNotice(
          turn.hands.length
            ? '有学生举手。点击学生邀请发言，也可以继续讲解。'
            : '暂时没有学生举手。可以继续讲解，或点名邀请一位学生。',
        );
      }
    } catch (e) {
      if (!controller.signal.aborted && token === publication.current) {
        if (
          ['STUDENT_GENERATION_FAILED', 'MODEL_OUTPUT_INVALID', 'TURN_FAILED'].includes(
            (e as { code?: string }).code ?? '',
          )
        )
          reactionRequests.current.delete(triggerId);
        setError(e instanceof Error ? e.message : '学生回应失败');
        setRetryTrigger(triggerId);
      }
    } finally {
      if (token === publication.current) setThinking(false);
    }
  }
  async function control(command: string, studentId?: string) {
    stopLocal();
    recorder.cancelRecording();
    try {
      const event = await mutate('commands', {
        command,
        ...(studentId ? { studentId } : {}),
        ...(command === 'end' ? { confirmed: true } : {}),
      });
      setRecover(false);
      setEnding(false);
      setNotice('');
      setRetryTrigger(undefined);
      if (command === 'call_on') void react(event.id);
    } catch {
      /* mutate displays the actionable error */
    }
  }
  async function submit() {
    if (!speech.trim() || !canWrite || saving) return;
    const text = speech;
    stopLocal();
    recorder.cancelRecording();
    try {
      const event = await mutate('events', {
        type: 'teacher_text',
        text,
        intent,
        input: speechInput,
      });
      setSpeech((value) => (value === text ? '' : value));
      setSpeechInput('text');
      void react(event.id);
    } catch {
      /* Keep teacher input intact. */
    }
  }
  async function event(body: Record<string, unknown>) {
    stopLocal();
    setRetryTrigger(undefined);
    await mutate('events', body);
  }
  const leave = () => {
    if (saving) {
      setNotice('正在保存课堂，请保存完成后返回。');
      return;
    }
    if (
      (speech.trim() || boardDirty) &&
      !window.confirm('还有未提交的发言或板书，确定放弃并返回？已保存的课堂不会结束。')
    )
      return;
    allowLeave.current = true;
    stopLocal();
    recorder.cancelRecording();
    window.location.assign('/teacher-training');
  };
  if (!detail)
    return (
      <main className={styles.classroom}>
        <div className={styles.empty}>
          <Presentation size={38} />
          <h2>{error ? '课堂暂时无法打开' : '正在打开课堂'}</h2>
          <p>{error || '读取本轮材料和已保存记录…'}</p>
          <button onClick={leave}>返回备课与历史</button>
        </div>
      </main>
    );
  const { session, classroom, classConfig, material } = detail;
  const pages = material.content.pages ?? [];
  const index = pages.findIndex((p) => p.id === classroom.pageId);
  const page = pages[index >= 0 ? index : 0];
  const elapsed = teachingSeconds(detail.events, now);
  const lastStudent = detail.events.findLast((e) => e.type === 'student_speech');
  const changePage = (pageId: string) => {
    if (boardDirty && !window.confirm('有未保存板书，确定放弃并切换页面？')) return;
    setBoardDirty(false);
    void event({ type: 'page_exposure', pageId }).catch(() => {});
  };
  return (
    <main className={styles.classroom}>
      <header className={styles.topbar}>
        <button title="返回备课与历史" onClick={leave}>
          <ArrowLeft size={17} />
          <span>返回</span>
        </button>
        <div className={styles.topbarTitle}>
          <h1>{page?.title || '教师模拟课堂'}</h1>
          <p>材料 V{material.number} · 独立试讲 · 你是本堂课的教师</p>
        </div>
        <span className={styles.status}>{recover ? '等待恢复' : statusLabels[session.status]}</span>
        <span className={styles.clock} title="课堂经过时长（不含暂停；离线时间尚未单独校准）">
          {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
          {String(elapsed % 60).padStart(2, '0')}
        </span>
        <button aria-label="模型与语音设置" onClick={() => setSettings(true)}>
          <Settings size={17} />
        </button>
      </header>
      {error && (
        <div className={styles.notice} role="alert">
          {error}
          {retryTrigger && <button onClick={() => void react(retryTrigger)}>重试学生回应</button>}
          <button onClick={() => setSettings(true)}>模型设置</button>
        </div>
      )}
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
          <button aria-label="关闭提示" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      {elapsed >= session.trainingConfig.plannedMinutes * 60 && (
        <div className={styles.notice}>已达到预设时长，你可以继续试讲，或主动结束本轮。</div>
      )}
      <div className={styles.body}>
        <aside className={styles.rail} aria-label="课堂课件导航">
          <h2>本轮课件 · {pages.length} 页</h2>
          {pages.map((p, i) => (
            <button
              key={p.id}
              disabled={!canWrite || saving}
              aria-pressed={p.id === page?.id}
              onClick={() => changePage(p.id)}
            >
              <div className={styles.railPreview}>
                <TrainingSlide slide={p.canvas} />
              </div>
              <div className={styles.railLabel}>
                <span>{String(i + 1).padStart(2, '0')}</span>
                {p.title}
              </div>
            </button>
          ))}
          {!pages.length && (
            <p style={{ fontSize: 12, color: '#728077' }}>
              本轮使用白板试讲。教案与备注不会自动展示给学生。
            </p>
          )}
        </aside>
        <section className={styles.main} aria-label="课堂舞台">
          <div className={styles.stageToolbar}>
            <div className={styles.switcher}>
              <button
                disabled={!canWrite || saving || !pages.length}
                aria-pressed={!classroom.boardOpen}
                onClick={() => {
                  if (boardDirty && !window.confirm('有未保存板书，确定放弃并切换课件？')) return;
                  setBoardDirty(false);
                  void event({ type: 'board_visibility', open: false }).catch(() => {});
                }}
              >
                <Presentation size={16} />
                课件
              </button>
              <button
                disabled={!canWrite || saving}
                aria-pressed={classroom.boardOpen}
                onClick={() => void event({ type: 'board_visibility', open: true }).catch(() => {})}
              >
                <PencilLine size={16} />
                白板
              </button>
            </div>
            <div className={styles.toolrow}>
              <button
                aria-label="上一页"
                disabled={!canWrite || saving || index <= 0}
                onClick={() => changePage(pages[index - 1].id)}
              >
                <ChevronLeft size={17} />
              </button>
              <small>
                {pages.length ? `${Math.max(index, 0) + 1} / ${pages.length}` : '白板课堂'}
              </small>
              <button
                aria-label="下一页"
                disabled={!canWrite || saving || index >= pages.length - 1}
                onClick={() => changePage(pages[index + 1].id)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
          <div className={styles.canvas}>
            {classroom.boardOpen ? (
              <TeachingBoard
                onDirtyChange={setBoardDirty}
                board={classroom.board}
                disabled={!canWrite || saving}
                onOperation={(operation: BoardOperation) =>
                  event({ type: 'board_operation', operation })
                }
              />
            ) : page ? (
              <TrainingSlide slide={page.canvas} />
            ) : (
              <div className={styles.empty}>
                <PencilLine size={44} />
                <h2>从你的第一笔开始</h2>
                <p>开课后打开白板，写下概念、公式或画出示意图。</p>
              </div>
            )}
          </div>
          <section className={styles.students} aria-label="虚拟学生">
            {lastStudent && (
              <div className={styles.studentBubble}>
                <strong>
                  {classConfig.students.find((s) => s.id === lastStudent.payload.studentId)?.name}：
                </strong>
                {lastStudent.payload.text}
              </div>
            )}
            <div className={styles.studentsTitle}>
              <span>虚拟班级 · {classConfig.students.length} 位学生</span>
              <span>{thinking ? '学生正在思考…' : '点击学生点名 · 教师随时可收回发言'}</span>
            </div>
            <div className={styles.studentRow}>
              {classConfig.students.map((student, i) => (
                <button
                  key={student.id}
                  className={styles.student}
                  disabled={!canWrite || saving}
                  aria-label={`点名${student.name}`}
                  data-hand={classroom.hands.includes(student.id)}
                  data-speaking={activeSpeaker === student.id}
                  onClick={() => void control('call_on', student.id)}
                >
                  <AgentAvatar
                    avatar={student.name.charAt(1) || student.name.charAt(0)}
                    name={student.name}
                    color={colors[i % colors.length]}
                    size="lg"
                  />
                  <small>
                    {classroom.hands.includes(student.id)
                      ? '举手 · 想说说看'
                      : activeSpeaker === student.id
                        ? '正在发言'
                        : '在听你讲课'}
                  </small>
                  {classroom.hands.includes(student.id) && (
                    <Hand size={20} className={styles.hand} />
                  )}
                </button>
              ))}
            </div>
          </section>
        </section>
        <aside className={styles.chat}>
          <div className={styles.chatHeader}>
            课堂对话<small>只记录实际公开的内容 · 正式评分待配置</small>
          </div>
          <div className={styles.messages} ref={messages} aria-label="课堂对话记录">
            {detail.events.map((e) =>
              e.payload.text ? (
                <article key={e.id} className={styles.message} data-actor={e.actorType}>
                  <header>
                    <strong>
                      {e.actorType === 'teacher'
                        ? '我 · 教师'
                        : classConfig.students.find((s) => s.id === e.payload.studentId)?.name}
                    </strong>
                    <time>
                      {new Date(e.receivedAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </header>
                  <p>{e.payload.text}</p>
                </article>
              ) : (
                <div key={e.id} className={styles.controlEvent}>
                  {labels[e.type] ?? e.type}
                  {e.payload.studentId
                    ? ` · ${classConfig.students.find((s) => s.id === e.payload.studentId)?.name}`
                    : ''}
                </div>
              ),
            )}
            {!detail.events.length && (
              <p style={{ fontSize: 13, color: '#728077', lineHeight: 1.8 }}>
                课堂开始后，你的讲解、学生回答、翻页和板书会保存在这一轮记录里。
              </p>
            )}
          </div>
        </aside>
      </div>
      <footer className={styles.footer}>
        <div className={styles.composer}>
          <textarea
            aria-label="教师课堂发言"
            value={speech}
            disabled={!canWrite}
            placeholder="输入讲解或问题。全班提问后，学生先举手，由你决定谁来回答。"
            onChange={(e) => setSpeech(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
            }}
          />
          <div className={styles.composerActions}>
            <select
              aria-label="发言方式"
              disabled={!canWrite}
              value={intent}
              onChange={(e) => setIntent(e.target.value as typeof intent)}
            >
              <option value="explain">讲解</option>
              <option value="question">全班提问</option>
              <option value="check">理解检查</option>
            </select>
            <button
              aria-label={recorder.isRecording ? '停止语音输入' : '语音输入'}
              disabled={!canWrite || recorder.isProcessing}
              onClick={() => {
                if (recorder.isRecording) recorder.stopRecording();
                else if (voiceAccepted) void recorder.startRecording();
                else setVoiceConsent(true);
              }}
            >
              {recorder.isRecording ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              className={styles.primary}
              disabled={!canWrite || saving || !speech.trim()}
              onClick={() => void submit()}
            >
              <Send size={16} />
              发送
            </button>
          </div>
        </div>
        <div className={styles.footerActions}>
          <small>
            {recorder.isRecording
              ? '正在转写，发送前可以核对文字'
              : thinking
                ? '正在生成学生反应；教师控制仍可使用'
                : 'Ctrl + Enter 发送 · 文字与语音转写使用同一轮课堂'}
          </small>
          <button
            onClick={() => {
              if (audioEnabled) window.speechSynthesis?.cancel();
              setAudioEnabled(!audioEnabled);
            }}
          >
            {audioEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}学生朗读
            {audioEnabled ? '开' : '关'}
          </button>
          {session.status === 'ready' && (
            <button
              className={styles.primary}
              disabled={saving}
              onClick={() => void control('start')}
            >
              <Play size={16} />
              开始课堂
            </button>
          )}

          {!recover && session.status === 'running' && (
            <>
              <button onClick={() => void control('interrupt')}>
                <Hand size={16} />
                收回发言
              </button>
              <button onClick={() => void control('pause')}>
                <Pause size={16} />
                暂停
              </button>
            </>
          )}
          {session.status === 'paused' && (
            <button
              className={styles.primary}
              disabled={saving}
              onClick={() => void control('resume')}
            >
              <Play size={16} />
              继续课堂
            </button>
          )}
          {session.status !== 'ended' && session.status !== 'ready' && (
            <button className={styles.danger} onClick={() => setEnding(true)}>
              <Square size={15} />
              结束本轮
            </button>
          )}
          {session.status === 'ended' && (
            <button
              className={styles.primary}
              onClick={() => window.location.assign(recordsHref(session.projectId, sessionId))}
            >
              查看本轮记录
            </button>
          )}
        </div>
      </footer>
      {recover && (
        <div className={styles.overlay}>
          <div className={styles.dialog} role="dialog" aria-label="恢复课堂">
            <h2>恢复已保存课堂</h2>
            <p>
              这一轮保留了材料、板书和对话。先恢复到暂停，再由你决定何时继续。不会自动补讲或生成学生回答。
            </p>
            <div className={styles.dialogActions}>
              <button onClick={leave}>返回</button>
              <button
                className={styles.primary}
                disabled={saving}
                onClick={() => void control('recover')}
              >
                恢复至暂停
              </button>
            </div>
          </div>
        </div>
      )}
      {ending && (
        <div className={styles.overlay}>
          <div className={styles.dialog} role="dialog" aria-label="结束本轮课堂">
            <h2>结束这一轮试讲？</h2>
            <p>
              已发生的课堂记录将封存。返回页面不需要结束课堂；结束后可查看记录并开启新轮次。
              {speech.trim() ? '当前还有未提交的讲解，请先返回课堂提交或清空。' : ''}
            </p>
            <div className={styles.dialogActions}>
              <button onClick={() => setEnding(false)}>继续课堂</button>
              <button
                className={styles.danger}
                disabled={saving || !!speech.trim()}
                onClick={() => void control('end')}
              >
                确认结束
              </button>
            </div>
          </div>
        </div>
      )}
      {voiceConsent && !recorder.isRecording && !recorder.isProcessing && (
        <div className={styles.overlay}>
          <div className={styles.dialog} role="dialog" aria-label="开启语音输入">
            <h2>用语音讲课</h2>
            <p>
              麦克风声音将交给你配置的语音识别服务进行转写。转写文字先进入输入框，核对后发送；当前不会保存可回听录音。不授权也可以继续文字试讲。
            </p>
            <div className={styles.dialogActions}>
              <button onClick={() => setVoiceConsent(false)}>使用文字</button>
              <button
                className={styles.primary}
                onClick={() => {
                  setVoiceConsent(false);
                  setVoiceAccepted(true);
                  void recorder.startRecording();
                }}
              >
                同意并开启麦克风
              </button>
            </div>
          </div>
        </div>
      )}
      {thinking && (
        <span aria-live="polite" className="sr-only">
          <Loader2 />
          学生正在思考
        </span>
      )}
      <SettingsDialog open={settings} onOpenChange={setSettings} />
    </main>
  );
}
