import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsState } from '@/lib/store/settings';
import {
  createStudentSpeechPlayer,
  studentSpeechOptions,
} from '@/lib/teacher-training/student-speech';

const browser = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('@/lib/audio/browser-tts-preview', () => ({ playBrowserTTSPreview: browser.play }));

class AudioFixture {
  static instances: AudioFixture[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  volume = 1;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor(public src: string) {
    AudioFixture.instances.push(this);
  }
}
const settings = (managed = false) => ({
  ttsProviderId: 'qwen-tts' as const,
  ttsVoice: 'Cherry',
  ttsSpeed: 1.1,
  ttsVolume: 0.7,
  ttsMuted: false,
  ttsProvidersConfig: {
    'qwen-tts': { apiKey: 'test-key', baseUrl: '', enabled: true, isServerConfigured: managed },
  } as SettingsState['ttsProvidersConfig'],
});
const response = () =>
  new Response(JSON.stringify({ success: true, base64: btoa('audio-bytes'), format: 'wav' }));
const fetchMock = vi.fn();

describe('student speech playback', () => {
  beforeEach(() => {
    AudioFixture.instances = [];
    fetchMock.mockReset().mockImplementation(async () => response());
    browser.play.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Audio', AudioFixture);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:student-audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the selected Qwen voice/model and waits for actual playback to end', async () => {
    const player = createStudentSpeechPlayer();
    let finished = false;
    const speech = player.speak('长轴沿纵轴。', studentSpeechOptions(settings())).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(AudioFixture.instances).toHaveLength(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      ttsProviderId: 'qwen-tts',
      ttsVoice: 'Cherry',
      ttsModelId: 'qwen3-tts-flash',
      ttsSpeed: 1.1,
      text: '长轴沿纵轴。',
    });
    expect(AudioFixture.instances[0].volume).toBe(0.7);
    expect(finished).toBe(false);
    AudioFixture.instances[0].onended?.();
    await speech;
    expect(finished).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:student-audio');
    expect(browser.play).not.toHaveBeenCalled();
  });

  it('does not send stale browser credentials for server-managed Qwen', async () => {
    const player = createStudentSpeechPlayer();
    const speech = player.speak('解释判断依据。', studentSpeechOptions(settings(true)));
    await vi.waitFor(() => expect(AudioFixture.instances).toHaveLength(1));
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).not.toHaveProperty('ttsApiKey');
    expect(request).not.toHaveProperty('ttsBaseUrl');
    AudioFixture.instances[0].onended?.();
    await speech;
  });

  it('aborts synthesis and cannot play a late audio result after teacher cancellation', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const player = createStudentSpeechPlayer();
    const speech = player.speak('不应迟到播放。', studentSpeechOptions(settings()));
    const rejected = expect(speech).rejects.toMatchObject({ name: 'AbortError' });
    player.cancel();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    release(response());
    await rejected;
    expect(AudioFixture.instances).toHaveLength(0);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('stops active audio on pause, releases resources, and allows the next turn', async () => {
    const controller = new AbortController();
    const player = createStudentSpeechPlayer();
    const first = player.speak('被教师打断。', studentSpeechOptions(settings()), controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(AudioFixture.instances).toHaveLength(1));
    controller.abort();
    await rejected;
    expect(AudioFixture.instances[0].pause).toHaveBeenCalled();
    expect(AudioFixture.instances[0].removeAttribute).toHaveBeenCalledWith('src');
    const second = player.speak('新的一轮回答。', studentSpeechOptions(settings()));
    await vi.waitFor(() => expect(AudioFixture.instances).toHaveLength(2));
    AudioFixture.instances[1].onended?.();
    await second;
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('reports synthesis failure without falling back to a different voice', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'provider details' }), { status: 502 }),
    );
    await expect(
      createStudentSpeechPlayer().speak('已有文字。', studentSpeechOptions(settings())),
    ).rejects.toThrow('语音合成失败');
    expect(AudioFixture.instances).toHaveLength(0);
    expect(browser.play).not.toHaveBeenCalled();
  });

  it('cleans up when the browser rejects audio playback', async () => {
    class BlockedAudio extends AudioFixture {
      play = vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    }
    vi.stubGlobal('Audio', BlockedAudio);
    await expect(
      createStudentSpeechPlayer().speak('已有文字。', studentSpeechOptions(settings())),
    ).rejects.toThrow('浏览器未允许');
    expect(AudioFixture.instances[0].pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('honors mute and rejects disabled or unconfigured providers', async () => {
    const muted = settings();
    muted.ttsMuted = true;
    await createStudentSpeechPlayer().speak('保持静音。', studentSpeechOptions(muted));
    expect(fetchMock).not.toHaveBeenCalled();
    const disabled = settings();
    disabled.ttsProvidersConfig['qwen-tts'].serverDisabled = true;
    expect(() => studentSpeechOptions(disabled)).toThrow('配置并启用');
    const absent = settings();
    absent.ttsProvidersConfig['qwen-tts'].apiKey = '';
    expect(() => studentSpeechOptions(absent)).toThrow('配置并启用');
  });
});
