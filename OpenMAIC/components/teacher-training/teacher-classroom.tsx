'use client';
import { useEffect, useState } from 'react';
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
  Phone,
  Send,
  Settings,
  Loader2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { BoardOperation } from '@/lib/teacher-training/classroom-contracts';
import { recordsHref } from '@/lib/teacher-training/client';
import { TrainingSettings } from './settings-panel';
import { useTeacherClassroomController } from './use-teacher-classroom-controller';
import { ClassroomClock, ClassroomLimitNotice } from './classroom-clock';
import { ClassroomTranscript } from './classroom-transcript';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { TrainingSlide } from './slide-surface';
import { TeachingBoard } from './teaching-board';
import { FaceCaptureControl } from './face-capture-control';
import styles from './classroom.module.css';

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
const voicePhases = {
  connecting: '正在连接',
  ready: '麦克风已开启，请说话',
  listening: '正在听你说话',
  thinking: '学生正在思考',
  speaking: '学生正在回答',
  closing: '正在结束通话',
};
export function TeacherClassroom({ sessionId }: { sessionId: string }) {
  const controller = useTeacherClassroomController(sessionId);
  const {
    detail,
    error,
    notice,
    setNotice,
    speech,
    setSpeech,
    intent,
    setIntent,
    canWrite,
    saving,
    thinking,
    recover,
    settings,
    settingsSection,
    setSettings,
    ending,
    setEnding,
    voiceConsent,
    setVoiceConsent,
    voiceAccepted,
    setVoiceAccepted,
    boardDirty,
    setBoardDirty,
    audioEnabled,
    audioBusy,
    setAudioEnabled,
    retryTrigger,
    activeSpeaker,
    voiceConfigured,
    voiceMode,
    setVoiceMode,
    voiceCall,
    callStudent,
    interruptVoice,
    recorder,
    react,
    control,
    submit,
    event,
    leave,
  } = controller;
  const [compact, setCompact] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const { scrollToLatest } = controller;
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!chatOpen) return;
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [chatOpen, scrollToLatest]);
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
  const lastStudent = detail.events.findLast((e) => e.type === 'student_speech');
  const lastStudentText = lastStudent?.payload.turnId
    ? detail.events
        .filter(
          (event) =>
            event.type === 'student_speech' && event.payload.turnId === lastStudent.payload.turnId,
        )
        .map((event) => event.payload.text ?? '')
        .join('')
    : lastStudent?.payload.text;
  const changePage = (pageId: string) => {
    if (boardDirty && !window.confirm('有未保存板书，确定放弃并切换页面？')) return;
    setBoardDirty(false);
    void event({ type: 'page_exposure', pageId }).catch(() => {});
  };
  return (
    <main className={styles.classroom}>
      <header className={styles.topbar}>
        <button title="返回备课与历史" disabled={saving} onClick={leave}>
          <ArrowLeft size={17} />
          <span>返回</span>
        </button>
        <div className={styles.topbarTitle}>
          <h1>{page?.title || '教师模拟课堂'}</h1>
          <p>
            材料 V{material.number} · {session.rehearsal ? '片段重练' : '独立试讲'} ·
            你是本堂课的教师
          </p>
        </div>
        <span className={styles.status}>{recover ? '等待恢复' : statusLabels[session.status]}</span>
        <ClassroomClock
          events={detail.events}
          plannedMinutes={session.trainingConfig.plannedMinutes}
        />
        {compact && (
          <button onClick={() => setChatOpen(true)}>
            课堂对话{controller.newMessages ? ' · 新消息' : ''}
          </button>
        )}
        <button aria-label="模型与语音设置" onClick={() => setSettings(true)}>
          <Settings size={17} />
        </button>
      </header>
      {session.rehearsal && session.status === 'ready' && (
        <div className={styles.notice}>
          <p>
            {session.rehearsal.kind === 'response'
              ? '开课时会展示这条原学生回答。请练习如何回应或追问。'
              : '请围绕原提问重新组织措辞，并留出作答机会。'}
          </p>
          <blockquote>{session.rehearsal.prompt}</blockquote>
        </div>
      )}
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
      {session.status !== 'ended' && (
        <ClassroomLimitNotice
          events={detail.events}
          plannedMinutes={session.trainingConfig.plannedMinutes}
        />
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
          <div className={styles.stageContent} data-camera={session.status !== 'ended'}>
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
            {session.status !== 'ended' && (
              <FaceCaptureControl key={sessionId} sessionId={sessionId} running={canWrite} />
            )}
          </div>
          <section className={styles.students} aria-label="虚拟学生">
            {lastStudent && (
              <div className={styles.studentBubble}>
                <strong>
                  {classConfig.students.find((s) => s.id === lastStudent.payload.studentId)?.name}：
                </strong>
                {lastStudentText}
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
                  data-speaking={
                    activeSpeaker === student.id ||
                    (voiceCall?.studentId === student.id && voiceCall.phase === 'speaking')
                  }
                  onClick={() => callStudent(student.id)}
                >
                  <span
                    className={styles.studentAvatar}
                    style={{ background: colors[i % colors.length] }}
                  >
                    {student.name.slice(-1)}
                  </span>
                  <strong>{student.name}</strong>
                  <small>
                    {voiceCall?.studentId === student.id
                      ? '实时对话'
                      : classroom.hands.includes(student.id)
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
        {!compact && <ClassroomTranscript detail={detail} controller={controller} />}
      </div>
      <footer className={styles.footer}>
        {voiceCall && (
          <section className={styles.voiceCall} aria-label="点名实时通话">
            <div className={styles.voiceCallHeader}>
              <Phone size={16} />
              <strong>
                {classConfig.students.find((student) => student.id === voiceCall.studentId)?.name} ·
                实时通话
              </strong>
              <span role="status">{voicePhases[voiceCall.phase]}</span>
              <button
                type="button"
                disabled={voiceCall.phase !== 'speaking'}
                onClick={interruptVoice}
              >
                停止当前回答
              </button>
            </div>
            {voiceCall.teacherCaption && <p>教师 · {voiceCall.teacherCaption}</p>}
            {voiceCall.studentCaption && <p>学生 · {voiceCall.studentCaption}</p>}
          </section>
        )}
        <div className={styles.composer}>
          <textarea
            aria-label="教师课堂发言"
            value={speech}
            disabled={!canWrite || !!voiceCall}
            placeholder="输入讲解或问题。全班提问后，学生先举手，由你决定谁来回答。"
            onChange={(e) => setSpeech(e.target.value)}
            onKeyDown={(e) => {
              if (!e.nativeEvent.isComposing && e.key === 'Enter' && (e.ctrlKey || e.metaKey))
                void submit();
            }}
          />
          <div className={styles.composerActions}>
            <div className={styles.intentTabs} role="group" aria-label="发言方式">
              {(
                [
                  ['explain', '讲解'],
                  ['question', '全班提问'],
                  ['check', '理解检查'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={!canWrite || !!voiceCall}
                  aria-pressed={intent === value}
                  onClick={() => setIntent(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              aria-label={recorder.isRecording ? '停止语音输入' : '语音输入'}
              disabled={!canWrite || recorder.isProcessing || !!voiceCall}
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
              disabled={!canWrite || saving || !speech.trim() || !!voiceCall}
              onClick={() => void submit()}
            >
              <Send size={16} />
              发送
            </button>
          </div>
        </div>
        <div className={styles.footerActions}>
          <small>
            {voiceMode && !voiceCall
              ? '实时点名已开启。点名会打开麦克风，并将语音发送至百炼。'
              : recorder.isRecording
                ? '正在转写，发送前可以核对文字'
                : audioBusy
                  ? '正在准备或播放学生语音；教师控制仍可使用'
                  : thinking
                    ? '正在生成学生反应；教师控制仍可使用'
                    : 'Ctrl + Enter 发送 · 文字与语音转写使用同一轮课堂'}
          </small>
          {voiceConfigured && (
            <button
              type="button"
              aria-pressed={voiceMode}
              disabled={!!voiceCall}
              onClick={() => setVoiceMode(!voiceMode)}
            >
              <Phone size={16} /> 实时点名{voiceMode ? '开' : '关'}
            </button>
          )}
          <button
            aria-pressed={audioEnabled}
            title="使用语音设置中的服务与音色，支持千问 TTS"
            onClick={() => setAudioEnabled(!audioEnabled)}
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
      <Dialog open={compact && chatOpen} onOpenChange={setChatOpen}>
        <DialogContent className={styles.transcriptDialog}>
          <DialogTitle>课堂对话</DialogTitle>
          <DialogDescription>查看已公开的课堂记录，关闭后继续授课。</DialogDescription>
          <ClassroomTranscript detail={detail} controller={controller} />
        </DialogContent>
      </Dialog>
      <TrainingSettings
        open={settings}
        onOpenChange={setSettings}
        initialSection={settingsSection}
      />
    </main>
  );
}
