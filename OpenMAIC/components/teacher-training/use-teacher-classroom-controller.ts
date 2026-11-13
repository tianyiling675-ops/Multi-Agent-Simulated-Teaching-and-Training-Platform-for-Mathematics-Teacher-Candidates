'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionDetail, ClassroomEvent } from '@/lib/teacher-training/contracts';
import { trainingApi } from '@/lib/teacher-training/client';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useSettingsStore } from '@/lib/store/settings';
import type { SettingsSection } from '@/lib/types/settings';
import { splitLongSpeechText } from '@/lib/audio/tts-utils';
import {
  createStudentSpeechPlayer,
  isStudentSpeechCancelled,
  studentSpeechOptions,
} from '@/lib/teacher-training/student-speech';
import { openTeacherVoice, type VoiceStatus } from '@/lib/teacher-training/voice-client';

type PublicTurn = {
  id: string;
  studentId?: string;
  speakerEpoch: number;
  status: string;
  committedLength: number;
  speech: string;
  hands: string[];
};

export function useTeacherClassroomController(sessionId: string) {
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('providers');
  const [ending, setEnding] = useState(false);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [voiceAccepted, setVoiceAccepted] = useState(false);
  const [boardDirty, setBoardDirty] = useState(false);
  const [audioEnabled, updateAudioEnabled] = useState(false);
  const audioEnabledRef = useRef(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [speechPlayer] = useState(createStudentSpeechPlayer);
  const setAudioEnabled = (enabled: boolean) => {
    if (enabled) {
      try {
        studentSpeechOptions(useSettingsStore.getState());
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : '请先配置语音合成。');
        setSettingsSection('tts');
        setSettings(true);
        return;
      }
    }
    audioEnabledRef.current = enabled;
    updateAudioEnabled(enabled);
    if (!enabled) {
      speechPlayer.cancel();
      setAudioBusy(false);
    }
  };
  const [retryTrigger, setRetryTrigger] = useState<string>();
  const [activeSpeaker, setActiveSpeaker] = useState<string>();
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceCall, setVoiceCall] = useState<(VoiceStatus & { studentId: string }) | null>(null);
  const voiceConnection = useRef<ReturnType<typeof openTeacherVoice> | null>(null);
  const voiceDrain = useRef(Promise.resolve());
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
    async (initial = false, timeoutMs?: number) => {
      const previous = current.current;
      const next: SessionDetail =
        initial || !previous
          ? await trainingApi<SessionDetail>(`sessions/${sessionId}`, undefined, { timeoutMs })
          : {
              ...previous,
              ...(await trainingApi<Pick<SessionDetail, 'session' | 'events' | 'classroom'>>(
                `sessions/${sessionId}/runtime`,
                undefined,
                { timeoutMs },
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
    speechPlayer.cancel();
    setAudioBusy(false);
    setThinking(false);
    setActiveSpeaker(undefined);
  }, [speechPlayer]);
  const stopVoice = useCallback(() => {
    const connection = voiceConnection.current;
    if (connection) {
      voiceConnection.current = null;
      voiceDrain.current = connection.stop().then(async () => {
        if (mounted.current) await load(false, 3_000).catch(() => {});
      });
      if (mounted.current) setVoiceCall(null);
    }
    return voiceDrain.current;
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    void load(true).catch((e) => setError(e.message));
    const status = new AbortController();
    void trainingApi<{ configured: boolean }>('voice-status', undefined, { signal: status.signal })
      .then((result) => {
        if (!status.signal.aborted) setVoiceConfigured(result.configured);
      })
      .catch(() => {});
    const publicationRef = publication;
    return () => {
      mounted.current = false;
      status.abort();
      void stopVoice();
      generation.current?.abort();
      publicationRef.current++;
      speechPlayer.cancel();
    };
  }, [load, speechPlayer, stopVoice]);
  const follow = useRef(true);
  const [newMessages, setNewMessages] = useState(false);
  const onTranscriptScroll = () => {
    const el = messages.current;
    if (!el) return;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (follow.current) setNewMessages(false);
  };
  const scrollToLatest = useCallback(() => {
    follow.current = true;
    messages.current?.scrollTo({ top: messages.current.scrollHeight, behavior: 'smooth' });
    setNewMessages(false);
  }, []);
  const attachTranscript = useCallback((node: HTMLDivElement | null) => {
    messages.current = node;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, []);
  useEffect(() => {
    if (follow.current)
      messages.current?.scrollTo({ top: messages.current.scrollHeight, behavior: 'smooth' });
    else setNewMessages(true);
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
        let audioFailed = false;
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
          if (audioEnabledRef.current && !audioFailed) {
            try {
              setAudioBusy(true);
              for (const chunk of splitLongSpeechText(part, 400)) {
                if (!audioEnabledRef.current || token !== publication.current) break;
                await speechPlayer.speak(
                  chunk,
                  studentSpeechOptions(useSettingsStore.getState()),
                  controller.signal,
                );
              }
            } catch (cause) {
              if (!isStudentSpeechCancelled(cause) && token === publication.current) {
                audioFailed = true;
                setNotice(
                  `学生文字已保留，本次继续显示文字。${cause instanceof Error ? cause.message : '语音暂时不可用。'}`,
                );
              }
            } finally {
              if (token === publication.current) setAudioBusy(false);
            }
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
    await stopVoice();
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

  function callStudent(studentId: string) {
    if (!voiceMode) {
      void control('call_on', studentId);
      return;
    }
    if (!canWrite || saving) return;
    const draining = stopVoice();
    stopLocal();
    recorder.cancelRecording();
    setError('');
    setNotice('');
    setRetryTrigger(undefined);
    let triggerId: string | undefined;
    const release = async () => {
      if (triggerId)
        await trainingApi(
          `sessions/${sessionId}/voice-release`,
          { triggerId },
          { timeoutMs: 4_000 },
        ).catch(() => {});
    };
    try {
      const connection = openTeacherVoice(
        async (signal) => {
          await draining;
          signal.throwIfAborted();
          const event = await mutate('commands', { command: 'call_on', studentId, voice: true });
          triggerId = event.id;
          if (signal.aborted) {
            await release();
            signal.throwIfAborted();
          }
          return trainingApi<{ url: string; ticket: string }>(
            `sessions/${sessionId}/voice-ticket`,
            { triggerId },
            { signal, timeoutMs: 6_000 },
          );
        },
        {
          update: (status) => {
            if (voiceConnection.current === connection)
              setVoiceCall((currentCall) => currentCall && { ...currentCall, ...status });
          },
          saved: () => {
            void load().catch(() => {});
          },
          notice: setNotice,
          closed: (message) => {
            const released = release();
            if (voiceConnection.current !== connection) return;
            voiceConnection.current = null;
            setVoiceCall(null);
            if (message) setError(message);
            void released.then(() => load()).catch(() => {});
          },
        },
      );
      voiceConnection.current = connection;
      setVoiceCall({ studentId, phase: 'connecting', teacherCaption: '', studentCaption: '' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法开启点名通话。');
    }
  }

  async function submit() {
    if (!speech.trim() || !canWrite || saving) return;
    const text = speech;
    stopLocal();
    recorder.cancelRecording();
    await stopVoice();
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
    await stopVoice();
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
    void stopVoice().then(() => window.location.assign('/teacher-training'));
  };
  return {
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
    interruptVoice: () => voiceConnection.current?.interrupt(),
    recorder,
    react,
    control,
    submit,
    event,
    leave,
    attachTranscript,
    onTranscriptScroll,
    scrollToLatest,
    newMessages,
  };
}
