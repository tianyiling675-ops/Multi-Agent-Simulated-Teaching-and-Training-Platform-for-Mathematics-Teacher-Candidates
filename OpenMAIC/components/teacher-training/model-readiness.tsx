'use client';
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleHelp, Loader2, Settings } from 'lucide-react';
import { useSettingsStore } from '@/lib/store/settings';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { TrainingSettings } from './settings-panel';
import styles from './workbench.module.css';

export function ModelReadiness() {
  useSettingsStore((state) => state.providerId);
  useSettingsStore((state) => state.modelId);
  useSettingsStore((state) => state.providersConfig);
  const config = getCurrentModelConfig();
  // Kept only in memory, never displayed, logged or persisted.
  const signature = JSON.stringify([
    config.modelString,
    config.apiKey,
    config.baseUrl,
    config.providerType,
  ]);
  const current = useRef(signature);
  current.current = signature;
  const [result, setResult] = useState<{
    signature: string;
    status: 'checking' | 'success' | 'failed';
    at?: string;
    message?: string;
  }>();
  const [settings, setSettings] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const valid = result?.signature === signature ? result : undefined;
  async function check() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setResult({ signature, status: 'checking' });
    try {
      const response = await fetch('/api/verify-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.modelString,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          providerType: config.providerType,
        }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
      });
      if (!response.ok) throw new Error('检测未成功，请检查模型设置或稍后重试。');
      if (request.signal.aborted || current.current !== signature) return;
      setResult({
        signature,
        status: 'success',
        at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      });
    } catch {
      if (request.signal.aborted || current.current !== signature) return;
      setResult({ signature, status: 'failed', message: '检测未成功，仍可准备材料或使用白板。' });
    }
  }
  return (
    <div className={styles.modelReadiness} aria-label="模型连接检查">
      <div>
        {valid?.status === 'success' ? (
          <CircleCheck size={18} />
        ) : valid?.status === 'checking' ? (
          <Loader2 size={18} className={styles.spin} />
        ) : (
          <CircleHelp size={18} />
        )}
        <span>
          {valid?.status === 'success'
            ? `连接检测成功 · ${valid.at}`
            : valid?.status === 'checking'
              ? '正在检测连接…'
              : valid?.status === 'failed'
                ? '连接检测失败'
                : '模型连接尚未检测'}
        </span>
      </div>
      <div className={styles.cardActions}>
        <button type="button" onClick={() => void check()} disabled={valid?.status === 'checking'}>
          检测连接
        </button>
        <button type="button" onClick={() => setSettings(true)}>
          <Settings size={14} />
          模型设置
        </button>
      </div>
      <p>{valid?.message ?? '检测会发送一次简短测试请求；仅用于确认当前模型连接。'}</p>
      <TrainingSettings open={settings} onOpenChange={setSettings} />
    </div>
  );
}
