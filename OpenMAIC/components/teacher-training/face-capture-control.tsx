'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Video, VideoOff } from 'lucide-react';
import {
  listFaceCameras,
  startFaceCapture,
  type FaceCapture,
} from '@/lib/teacher-training/face-capture-client';
import styles from './classroom.module.css';

export function FaceCaptureControl({
  sessionId,
  running,
}: {
  sessionId: string;
  running: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const capture = useRef<FaceCapture | null>(null);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const [phase, setPhase] = useState<'off' | 'opening' | 'waiting' | 'preview' | 'ready'>('off');
  const [face, setFace] = useState<boolean>();
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [interrupted, setInterrupted] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [activeCamera, setActiveCamera] = useState('');
  const deviceSelect = useId();

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const media = navigator.mediaDevices;
    const refresh = () =>
      void listFaceCameras()
        .then((items) => {
          if (active) setDevices(items);
        })
        .catch(() => {});
    refresh();
    media?.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      media?.removeEventListener('devicechange', refresh);
      mounted.current = false;
      capture.current?.stop();
      capture.current = null;
    };
  }, []);

  useEffect(() => capture.current?.setRunning(running), [running]);

  function stop() {
    attempt.current++;
    capture.current?.stop();
    capture.current = null;
    setPhase('off');
  }

  function open(idToOpen: string) {
    if (!video.current) return;
    stop();
    setError('');
    setModelError('');
    setInterrupted(false);
    setActiveCamera('');
    setFace(undefined);
    setPhase('opening');
    const id = ++attempt.current;
    const current = () => mounted.current && attempt.current === id;
    const refresh = () =>
      void listFaceCameras()
        .then((items) => {
          if (current()) setDevices(items);
        })
        .catch(() => {});
    capture.current = startFaceCapture(sessionId, video.current, running, idToOpen, {
      connected: (actualId, label) => {
        if (!current()) return;
        setDeviceId(actualId);
        setActiveCamera(label);
        setPhase('waiting');
        refresh();
      },
      preview: () => {
        if (current()) setPhase('preview');
      },
      interrupted: (value) => {
        if (!current()) return;
        setInterrupted(value);
        if (value) setFace(undefined);
      },
      modelError: (message) => {
        if (current()) setModelError(message);
      },
      ready: () => {
        if (current()) setPhase('ready');
      },
      sample: (visible) => {
        if (current()) setFace(visible);
      },
      error: (message, fatal) => {
        if (!current()) return;
        setError(message);
        if (fatal) {
          capture.current = null;
          setPhase('off');
          refresh();
        }
      },
    });
  }

  const enabled = phase !== 'off';
  const preview = (phase === 'preview' || phase === 'ready') && !interrupted;
  const status =
    phase === 'off'
      ? '画面在浏览器处理，仅保存动作摘要。'
      : phase === 'opening'
        ? '正在连接摄像头…'
        : phase === 'waiting'
          ? '已连接，正在等待摄像头画面…'
          : interrupted
            ? '摄像头暂未提供画面。请检查隐私开关或切换设备。'
            : modelError
              ? '摄像头画面已连接。'
              : phase === 'preview'
                ? '摄像头画面已连接，正在加载表情模型…'
                : !running
                  ? '摄像头已开启，课堂进行时才采样。'
                  : face === false
                    ? '未检测到单张清晰人脸。若预览为黑屏或占位图，请切换摄像头。'
                    : face === true
                      ? '正在采集本轮表情证据。'
                      : '正在等待首个分析结果…';
  return (
    <section className={styles.faceCapture} aria-label="试讲表情分析">
      <div className={styles.faceHeading}>
        <Video size={16} aria-hidden="true" />
        教师摄像头
      </div>
      <div className={styles.facePreview} data-preview={preview}>
        <video ref={video} autoPlay muted playsInline aria-label="本机摄像头预览" />
        {!preview && (
          <div aria-hidden="true">
            <VideoOff size={24} />
            <span>{enabled ? '等待画面' : '摄像头已关闭'}</span>
          </div>
        )}
      </div>
      <div className={styles.faceControls}>
        <label htmlFor={deviceSelect}>摄像头设备</label>
        <select
          id={deviceSelect}
          value={deviceId}
          title={activeCamera || undefined}
          onChange={(event) => {
            const next = event.target.value;
            setDeviceId(next);
            if (enabled) open(next);
          }}
        >
          <option value="">系统默认</option>
          {deviceId && !devices.some((item) => item.deviceId === deviceId) && (
            <option value={deviceId}>{activeCamera || '已选摄像头'}</option>
          )}
          {devices.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `摄像头 ${index + 1}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => (enabled ? stop() : open(deviceId))}
        >
          {enabled ? <VideoOff size={15} /> : <Video size={15} />}
          {enabled ? '关闭摄像头' : '开启摄像头并分析表情'}
        </button>
        <small role="status">{status}</small>
        {modelError && enabled && <small role="alert">表情分析不可用。{modelError}</small>}
        {error && <small role="alert">{error}</small>}
      </div>
    </section>
  );
}
