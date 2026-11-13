'use client';

import { DEFAULT_TTS_VOICES, TTS_PROVIDERS, resolveTTSModelForVoice } from '@/lib/audio/constants';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { playBrowserTTSPreview } from '@/lib/audio/browser-tts-preview';
import type { TTSProviderId } from '@/lib/audio/types';
import type { SettingsState } from '@/lib/store/settings';

export type StudentSpeechOptions = {
  providerId: TTSProviderId;
  modelId?: string;
  voice: string;
  speed: number;
  volume: number;
  muted: boolean;
  apiKey?: string;
  baseUrl?: string;
  providerOptions?: Record<string, unknown>;
};

export function studentSpeechOptions(
  settings: Pick<
    SettingsState,
    'ttsProviderId' | 'ttsProvidersConfig' | 'ttsVoice' | 'ttsSpeed' | 'ttsVolume' | 'ttsMuted'
  >,
): StudentSpeechOptions {
  const providerId = settings.ttsProviderId;
  const config = settings.ttsProvidersConfig[providerId];
  if (!isTTSProviderEnabled(providerId, config)) {
    throw new Error('请在“语音合成”中配置并启用语音服务，选择音色后再开启学生朗读。');
  }
  const provider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  const defaults: Partial<Record<TTSProviderId, string>> = DEFAULT_TTS_VOICES;
  const voice = settings.ttsVoice || defaults[providerId] || 'default';
  return {
    providerId,
    voice,
    modelId: resolveTTSModelForVoice(
      providerId,
      voice,
      config?.modelId || provider?.defaultModelId,
    ),
    speed: settings.ttsSpeed,
    volume: settings.ttsVolume,
    muted: settings.ttsMuted,
    // Managed credentials stay on the server, even if the browser retains old BYOK settings.
    ...(!config?.isServerConfigured && {
      apiKey: config?.apiKey || undefined,
      baseUrl: config?.baseUrl || config?.customDefaultBaseUrl || undefined,
    }),
    providerOptions: config?.providerOptions,
  };
}

export function isStudentSpeechCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** One cancellable sentence at a time. Audio is transient playback, not saved evidence. */
export function createStudentSpeechPlayer() {
  let active: AbortController | undefined;
  const cancel = () => active?.abort();

  async function speak(text: string, options: StudentSpeechOptions, callerSignal?: AbortSignal) {
    cancel();
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    if (callerSignal?.aborted) controller.abort();
    const signal = controller.signal;
    try {
      signal.throwIfAborted();
      if (!text.trim() || options.muted || options.volume <= 0) return;
      if (options.providerId === 'browser-native-tts') {
        const browser = playBrowserTTSPreview({ text, voice: options.voice, rate: options.speed });
        signal.addEventListener('abort', browser.cancel, { once: true });
        try {
          await browser.promise;
        } finally {
          signal.removeEventListener('abort', browser.cancel);
        }
        return;
      }
      const response = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        body: JSON.stringify({
          text,
          audioId: `training_${crypto.randomUUID()}`,
          ttsProviderId: options.providerId,
          ttsModelId: options.modelId,
          ttsVoice: options.voice,
          ttsSpeed: options.speed,
          ...(options.apiKey && { ttsApiKey: options.apiKey }),
          ...(options.baseUrl && { ttsBaseUrl: options.baseUrl }),
          ...(options.providerOptions && { ttsProviderOptions: options.providerOptions }),
        }),
      });
      signal.throwIfAborted();
      const result = await response.json();
      signal.throwIfAborted();
      if (!response.ok || typeof result.base64 !== 'string' || !result.base64) {
        throw new Error(
          response.ok
            ? '语音服务未返回可播放的音频。'
            : '语音合成失败，请检查语音设置、凭据和服务额度。',
        );
      }
      const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
      const format = result.format === 'wav' ? 'wav' : result.format === 'ogg' ? 'ogg' : 'mpeg';
      const url = URL.createObjectURL(new Blob([bytes], { type: `audio/${format}` }));
      let audio: HTMLAudioElement | undefined;
      try {
        signal.throwIfAborted();
        audio = new Audio(url);
        audio.volume = Math.max(0, Math.min(1, options.volume));
        const element = audio;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal.removeEventListener('abort', interrupted);
            element.onended = null;
            element.onerror = null;
            if (error) reject(error);
            else resolve();
          };
          const interrupted = () =>
            finish(new DOMException('Student speech cancelled', 'AbortError'));
          const timeout = setTimeout(
            () => finish(new Error('语音播放超时，请检查音频设备。')),
            180_000,
          );
          element.onended = () => finish();
          element.onerror = () => finish(new Error('音频无法播放，请检查浏览器和音频设备。'));
          signal.addEventListener('abort', interrupted, { once: true });
          if (signal.aborted) interrupted();
          else
            void element
              .play()
              .catch(() => finish(new Error('浏览器未允许播放声音，请重新开启学生朗读。')));
        });
      } finally {
        if (audio) {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        }
        URL.revokeObjectURL(url);
      }
    } finally {
      callerSignal?.removeEventListener('abort', abort);
      if (active === controller) active = undefined;
    }
  }
  return { speak, cancel };
}
