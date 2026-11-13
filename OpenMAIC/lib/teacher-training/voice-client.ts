'use client';

export interface VoiceStatus {
  phase: 'connecting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'closing';
  teacherCaption: string;
  studentCaption: string;
}

type VoiceTicket = { url: string; ticket: string };
type GatewayMessage = {
  type: string;
  id?: string;
  data?: string;
  text?: string;
  message?: string;
};

type PlayingResponse = {
  id: string;
  nodes: Map<AudioBufferSourceNode, { start: number; duration: number }>;
  played: number;
  scheduled: number;
  nextStart: number;
  done: boolean;
  drain?: ReturnType<typeof setTimeout>;
};

const outputSampleRate = 24_000;
const maxQueuedAudioSeconds = 30;

function createPlayback(
  context: AudioContext,
  report: (id: string, playedMs: number, interrupted: boolean) => void,
) {
  let current: PlayingResponse | undefined;

  function stop(id = current?.id) {
    const response = current;
    if (!response || response.id !== id) return;
    current = undefined;
    clearTimeout(response.drain);
    const clock = context.getOutputTimestamp?.().contextTime;
    const playedThrough = clock && clock > 0 ? clock : context.currentTime;
    let played = response.played;
    for (const [node, { start, duration }] of response.nodes) {
      played += Math.max(0, Math.min(duration, playedThrough - start));
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    response.nodes.clear();
    report(response.id, Math.round(played * 1000), true);
  }

  function complete(response: PlayingResponse) {
    if (current !== response || !response.done || response.nodes.size || response.drain) return;
    // Allow the final scheduled buffer to clear the browser's output pipeline.
    const latency = (context.outputLatency || context.baseLatency || 0) * 1000;
    response.drain = setTimeout(() => {
      if (current !== response) return;
      current = undefined;
      report(response.id, Math.round(response.scheduled * 1000), false);
    }, latency);
  }

  return {
    get id() {
      return current?.id;
    },
    start(id: string) {
      stop();
      current = { id, nodes: new Map(), played: 0, scheduled: 0, nextStart: 0, done: false };
    },
    enqueue(id: string, data: string) {
      const response = current;
      if (!response || response.id !== id || response.done) return;
      const raw = atob(data);
      if (!raw.length || raw.length % 2) return;
      const length = raw.length / 2;
      if (
        response.nextStart + length / outputSampleRate - context.currentTime >
        maxQueuedAudioSeconds
      )
        throw new Error('语音播放积压，请重新点名。');
      const buffer = context.createBuffer(1, length, outputSampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        const value = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
        samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
      }
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      const start = Math.max(context.currentTime + 0.035, response.nextStart);
      response.nextStart = start + buffer.duration;
      response.scheduled += buffer.duration;
      response.nodes.set(node, { start, duration: buffer.duration });
      node.onended = () => {
        response.nodes.delete(node);
        node.disconnect();
        response.played += buffer.duration;
        complete(response);
      };
      node.start(start);
    },
    finish(id: string) {
      if (current?.id !== id) return;
      current.done = true;
      complete(current);
    },
    stop,
  };
}

export function openTeacherVoice(
  authorize: (signal: AbortSignal) => Promise<VoiceTicket>,
  callbacks: {
    update: (status: Partial<VoiceStatus>) => void;
    saved: () => void;
    notice: (text: string) => void;
    closed: (error?: string) => void;
  },
) {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined')
    throw new Error('请使用支持麦克风的浏览器，并通过 HTTPS 或 localhost 打开课堂。');

  const context = new AudioContext();
  const abort = new AbortController();
  let stream: MediaStream | undefined;
  let microphone: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let socket: WebSocket | undefined;
  let ready = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const playback = createPlayback(context, (id, playedMs, interrupted) => {
    send({ type: 'played', id, playedMs, interrupted });
    if (!closed) callbacks.update({ phase: 'ready', studentCaption: '' });
  });

  function stop(error?: string) {
    if (closing) return closing;
    closed = true;
    abort.abort();
    stream?.getTracks().forEach((track) => track.stop());
    if (microphone) microphone.port.onmessage = null;
    microphone?.disconnect();
    source?.disconnect();
    playback.stop();
    void context.close().catch(() => {});
    callbacks.update({ phase: 'closing', teacherCaption: '', studentCaption: '' });
    closing = new Promise<void>((resolve) => {
      const connection = socket;
      if (connection?.readyState !== WebSocket.OPEN) {
        connection?.close();
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        connection.close();
        resolve();
      }, 1_200);
      connection.addEventListener(
        'close',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      send({ type: 'hangup' });
    });
    void closing.then(() => callbacks.closed(error));
    return closing;
  }

  function onMessage(event: MessageEvent) {
    if (closed) return;
    try {
      const message: GatewayMessage = JSON.parse(event.data);
      switch (message.type) {
        case 'ready':
          ready = true;
          callbacks.update({ phase: 'ready' });
          break;
        case 'listening':
          callbacks.update({ phase: 'listening', teacherCaption: '' });
          break;
        case 'thinking':
          callbacks.update({ phase: 'thinking' });
          break;
        case 'teacher-caption':
        case 'teacher-final':
          callbacks.update({ teacherCaption: message.text ?? '' });
          break;
        case 'response':
          if (message.id) playback.start(message.id);
          callbacks.update({ phase: 'thinking', studentCaption: '' });
          break;
        case 'audio':
          if (message.id && message.id === playback.id && message.data) {
            playback.enqueue(message.id, message.data);
            callbacks.update({ phase: 'speaking' });
          }
          break;
        case 'student-caption':
          if (message.id && message.id === playback.id)
            callbacks.update({ studentCaption: message.text ?? '' });
          break;
        case 'response-end':
          if (message.id) playback.finish(message.id);
          break;
        case 'cut':
          if (message.id) playback.stop(message.id);
          break;
        case 'saved':
          callbacks.saved();
          break;
        case 'notice':
          if (message.message) callbacks.notice(message.message);
          break;
        case 'error':
          void stop(message.message ?? '实时语音暂不可用。');
          break;
      }
    } catch (error) {
      void stop(error instanceof Error ? error.message : '实时音频无法播放。');
    }
  }

  const microphoneRequest = navigator.mediaDevices
    .getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    .then((media) => {
      if (abort.signal.aborted) media.getTracks().forEach((track) => track.stop());
      else stream = media;
      return media;
    });

  const setup = async () => {
    const [media] = await Promise.all([
      microphoneRequest,
      context.resume(),
      context.audioWorklet.addModule('/teacher-voice-microphone.js'),
    ]);
    abort.signal.throwIfAborted();
    for (const track of media.getAudioTracks()) {
      track.addEventListener(
        'ended',
        () => {
          if (!closed) void stop('麦克风已断开。');
        },
        { once: true },
      );
    }
    const grant = await authorize(abort.signal);
    abort.signal.throwIfAborted();
    const connection = new WebSocket(grant.url);
    socket = connection;
    connection.addEventListener('open', () => send({ type: 'start', ticket: grant.ticket }));
    connection.addEventListener('message', onMessage);
    connection.addEventListener('error', () => {
      if (!closed) void stop('无法连接实时语音服务。');
    });
    connection.addEventListener('close', () => {
      if (!closed) void stop('实时语音连接已结束。');
    });
    const connectionTimeout = setTimeout(() => {
      if (!ready && !closed) void stop('实时语音连接超时。');
    }, 12_000);
    connection.addEventListener('close', () => clearTimeout(connectionTimeout), { once: true });
    microphone = new AudioWorkletNode(context, 'teacher-voice-microphone', {
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    source = context.createMediaStreamSource(media);
    microphone.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      if (!ready || closed || connection.readyState !== WebSocket.OPEN) return;
      if (connection.bufferedAmount > 64 * 1024) {
        void stop('麦克风音频上传拥堵，请重新点名。');
        return;
      }
      connection.send(data);
    };
    source.connect(microphone);
    // The worklet emits silence to the audio graph and sends PCM to its port.
    microphone.connect(context.destination);
  };
  void setup().catch((error) => {
    if (closed) return;
    void stop(
      error instanceof Error && error.name === 'NotAllowedError'
        ? '麦克风权限未开启。可以授权后重新点名。'
        : error instanceof Error
          ? error.message
          : '无法开启点名通话。',
    );
  });

  return {
    stop,
    interrupt() {
      if (!playback.id || closed) return;
      send({ type: 'interrupt', id: playback.id });
      playback.stop();
    },
  };
}
