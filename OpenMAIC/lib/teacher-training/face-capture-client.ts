'use client';

import { trainingApi } from './client';
import {
  faceActions,
  faceSampleMs,
  faceWindowMs,
  type FaceEvidenceResponse,
  type FaceUpload,
  type FaceWindow,
} from './face-evidence';

type Actions = Record<keyof typeof faceActions, boolean>;
type WorkerResult =
  | { type: 'ready' | 'error' }
  | { type: 'sample'; timestamp: number; actions: Actions | null };

export type FaceCapture = { stop(): void; setRunning(running: boolean): void };

const videoConstraints = { width: { ideal: 480 }, height: { ideal: 360 } };
const isVirtualCamera = (label: string) => /virtual|虚拟/i.test(label);

export async function listFaceCameras() {
  const devices = await navigator.mediaDevices?.enumerateDevices();
  return (devices ?? []).filter((device) => device.kind === 'videoinput' && device.deviceId);
}

function cameraError(error: unknown) {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '未获摄像头权限。请检查站点和系统的摄像头权限。';
      case 'NotReadableError':
      case 'AbortError':
        return '摄像头被占用或无法读取。请选择其他摄像头，或关闭正在使用它的应用。';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return '找不到所选摄像头。请连接摄像头或选择其他设备。';
    }
  }
  return error instanceof Error ? error.message : '摄像头暂不可用。';
}

function firstCameraFrame(video: HTMLVideoElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const frame = video.requestVideoFrameCallback(() => {
      cleanup();
      resolve();
    });
    const timer = setTimeout(
      () => finish(new Error('摄像头已连接，但没有收到画面。请检查隐私遮挡开关或切换摄像头。')),
      8_000,
    );
    const cancelled = () => finish(signal.reason);
    function cleanup() {
      clearTimeout(timer);
      video.cancelVideoFrameCallback(frame);
      signal.removeEventListener('abort', cancelled);
    }
    function finish(error: unknown) {
      cleanup();
      reject(error);
    }
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

export function startFaceCapture(
  sessionId: string,
  video: HTMLVideoElement,
  initiallyRunning: boolean,
  deviceId: string,
  callbacks: {
    connected(deviceId: string, label: string): void;
    preview(): void;
    interrupted(interrupted: boolean): void;
    modelError(message: string): void;
    ready(): void;
    error(message: string, fatal: boolean): void;
    sample(visible: boolean): void;
  },
): FaceCapture {
  const endpoint = `sessions/${sessionId}/face-evidence`;
  const abort = new AbortController();
  let worker: Worker | undefined;
  let stream: MediaStream | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let running = initiallyRunning;
  let ready = false;
  let track: MediaStreamTrack | undefined;
  let samplingSince = performance.now();
  let lastFrame = -1;
  let inFlight = false;
  let saving = false;
  let clockOffset = 0;
  let upload: Pick<FaceUpload, 'generation' | 'modelVersion'> | undefined;
  let current: FaceWindow | undefined;
  let queue: FaceWindow[] = [];

  function closeWindow() {
    if (current) queue.push(current);
    current = undefined;
  }

  async function flush(retry = true): Promise<void> {
    if (saving || !upload || !queue.length) return;
    saving = true;
    let batch = queue.splice(0, 40);
    try {
      const options = { ...upload, windows: batch };
      await trainingApi(endpoint, options, { timeoutMs: 8_000, keepalive: true });
    } catch (error) {
      if (
        ['FACE_EVIDENCE_RESET', 'LIMIT_REACHED'].includes((error as { code?: string }).code ?? '')
      ) {
        queue = [];
        fail((error as Error).message);
        return;
      }
      if ((error as { code?: string }).code !== 'FACE_WINDOW_OUTSIDE_SESSION') {
        queue = [...batch, ...queue].slice(0, 120);
        batch = [];
      }
      callbacks.error('部分表情摘要未能保存。课堂可继续进行。', false);
    } finally {
      saving = false;
    }
    if (queue.length && (batch.length || (retry && abort.signal.aborted))) await flush(false);
  }

  function stop() {
    if (abort.signal.aborted) return;
    abort.abort();
    clearInterval(sampleTimer);
    clearInterval(saveTimer);
    clearTimeout(setupTimer);
    document.removeEventListener('visibilitychange', visibilityChanged);
    window.removeEventListener('pagehide', stop);
    worker?.terminate();
    stream?.getTracks().forEach((track) => track.stop());
    if (video.srcObject === stream) video.srcObject = null;
    closeWindow();
    void flush();
  }

  function fail(message: string) {
    stop();
    callbacks.error(message, true);
  }

  function failModel(message: string) {
    if (abort.signal.aborted) return;
    clearTimeout(setupTimer);
    ready = false;
    worker?.terminate();
    worker = undefined;
    callbacks.modelError(message);
  }

  function visibilityChanged() {
    samplingSince = performance.now();
    closeWindow();
    void flush();
  }

  async function capture() {
    if (
      !running ||
      !ready ||
      track?.muted ||
      inFlight ||
      document.hidden ||
      video.readyState < 2 ||
      video.currentTime === lastFrame
    )
      return;
    inFlight = true;
    lastFrame = video.currentTime;
    const timestamp = performance.now();
    try {
      const image = await createImageBitmap(video);
      if (abort.signal.aborted || timestamp < samplingSince) {
        image.close();
        inFlight = false;
        return;
      }
      try {
        worker!.postMessage({ type: 'frame', image, timestamp }, [image]);
      } catch (error) {
        image.close();
        throw error;
      }
    } catch {
      if (!abort.signal.aborted) failModel('无法读取视频帧进行表情分析。请重新开启分析。');
    }
  }

  function acceptSample(timestamp: number, actions: Actions | null) {
    inFlight = false;
    if (
      abort.signal.aborted ||
      timestamp < samplingSince ||
      !running ||
      track?.muted ||
      document.hidden
    )
      return;
    const at = Math.round(clockOffset + timestamp);
    if (current && at - current.startedAt >= faceWindowMs) closeWindow();
    current ??= {
      id: crypto.randomUUID(),
      startedAt: at,
      endedAt: at,
      samples: 0,
      visible: 0,
      smile: 0,
      browDown: 0,
      browUp: 0,
    };
    current.endedAt = at;
    current.samples++;
    if (actions) {
      current.visible++;
      for (const key of Object.keys(faceActions) as (keyof Actions)[]) {
        if (actions[key]) current[key]++;
      }
    }
    callbacks.sample(Boolean(actions));
  }

  async function connectCamera() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || !video.requestVideoFrameCallback)
        throw new Error(
          '当前环境无法预览摄像头，请使用支持摄像头的浏览器并通过 HTTPS 或本机地址访问。',
        );
      const open = (id: string) =>
        navigator.mediaDevices.getUserMedia({
          video: {
            ...videoConstraints,
            ...(id ? { deviceId: { exact: id } } : { facingMode: 'user' }),
          },
          audio: false,
        });
      try {
        stream = await open(deviceId);
      } catch (error) {
        if (
          deviceId ||
          abort.signal.aborted ||
          !(error instanceof DOMException) ||
          error.name !== 'NotReadableError'
        )
          throw error;
        const devices = await listFaceCameras().catch(() => []);
        for (const device of devices) {
          if (abort.signal.aborted) return false;
          // Windows also exposes aliases such as the default input.
          if (device.deviceId === 'default' || device.deviceId === 'communications') continue;
          stream = await open(device.deviceId).catch(() => undefined);
          if (stream) break;
        }
        if (!stream) throw error;
      }
      if (!deviceId && isVirtualCamera(stream.getVideoTracks()[0]?.label ?? '')) {
        const devices = await listFaceCameras().catch(() => []);
        for (const device of devices) {
          if (abort.signal.aborted) break;
          if (
            !device.label ||
            isVirtualCamera(device.label) ||
            device.deviceId === 'default' ||
            device.deviceId === 'communications'
          )
            continue;
          const alternative = await open(device.deviceId).catch(() => undefined);
          if (!alternative) continue;
          stream.getTracks().forEach((item) => item.stop());
          stream = alternative;
          break;
        }
      }
      if (abort.signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      track = stream.getVideoTracks()[0];
      if (!track) throw new Error('摄像头没有提供视频轨道。');
      track.addEventListener('ended', () => fail('摄像头连接已结束，请重新选择设备。'), {
        signal: abort.signal,
      });
      const interrupted = () => {
        visibilityChanged();
        callbacks.interrupted(Boolean(track?.muted));
      };
      track.addEventListener('mute', interrupted, { signal: abort.signal });
      track.addEventListener('unmute', interrupted, { signal: abort.signal });
      callbacks.connected(track.getSettings().deviceId ?? deviceId, track.label);
      video.srcObject = stream;
      await Promise.all([video.play(), firstCameraFrame(video, abort.signal)]);
      if (abort.signal.aborted) return false;
      callbacks.preview();
      interrupted();
      return true;
    } catch (error) {
      if (!abort.signal.aborted) fail(cameraError(error));
      return false;
    }
  }

  async function initialize() {
    if (!(await connectCamera()) || abort.signal.aborted) return;
    try {
      if (!globalThis.OffscreenCanvas || !globalThis.createImageBitmap)
        throw new Error('当前浏览器不支持表情分析。');
      const before = performance.now();
      const info = await trainingApi<FaceEvidenceResponse>(`${endpoint}?capture=1`, undefined, {
        signal: abort.signal,
        timeoutMs: 8_000,
      });
      if (abort.signal.aborted) return;
      clockOffset = info.serverTime - (before + performance.now()) / 2;
      upload = {
        generation: info.generation,
        modelVersion: info.modelVersion as FaceUpload['modelVersion'],
      };
      worker = new Worker('/teacher-face-worker.js');
      worker.onerror = () => failModel('表情模型无法启动。');
      worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
        if (data.type === 'ready') {
          clearTimeout(setupTimer);
          ready = true;
          callbacks.ready();
        } else if (data.type === 'error') {
          failModel('表情模型加载或推理失败。');
        } else if (data.type === 'sample') {
          acceptSample(data.timestamp, data.actions);
        }
      };
      setupTimer = setTimeout(() => failModel('表情模型加载超时。'), 20_000);
      worker.postMessage({ type: 'init' });
    } catch (error) {
      if (abort.signal.aborted) return;
      failModel(error instanceof Error ? error.message : '表情分析暂不可用。');
    }
  }

  const sampleTimer = setInterval(() => void capture(), faceSampleMs);
  const saveTimer = setInterval(() => {
    closeWindow();
    void flush();
  }, 10_000);
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', stop);
  void initialize();
  return {
    stop,
    setRunning(next) {
      if (next === running) return;
      running = next;
      visibilityChanged();
    },
  };
}
