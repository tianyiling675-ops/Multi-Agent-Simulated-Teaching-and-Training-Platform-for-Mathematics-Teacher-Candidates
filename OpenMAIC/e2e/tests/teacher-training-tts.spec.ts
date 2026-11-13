import { expect, test } from '@playwright/test';

function sampleWav() {
  const samples = 8000 * 5;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 220) / 8000) * 500), 44 + i * 2);
  return wav.toString('base64');
}

test('Qwen student audio follows speech settings, pauses immediately, and preserves text on TTS failure', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const state = { played: 0, started: 0, current: null as HTMLMediaElement | null, native: 0 };
    Object.assign(window, { trainingAudioFixture: state });
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      state.played++;
      state.current = this;
      this.addEventListener('playing', () => state.started++, { once: true });
      return original.call(this);
    };
    if (window.speechSynthesis)
      window.speechSynthesis.speak = () => {
        state.native++;
      };
  });
  await page.route('**/api/server-providers', (route) =>
    route.fulfill({
      json: {
        success: true,
        providers: {},
        tts: { 'qwen-tts': {} },
        asr: {},
        pdf: {},
        image: {},
        video: {},
        webSearch: {},
      },
    }),
  );
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/teacher-training/' + path, { data });
    expect(response.ok()).toBe(true);
    return (await response.json()).data;
  };
  const key = () => crypto.randomUUID();
  const project = await post('projects', {
    title: '千问学生语音验收',
    grade: '高二',
    scope: '长轴方向',
    clientRequestId: key(),
  });
  await page.request.patch('/api/teacher-training/drafts/' + project.id, {
    data: {
      expectedRevision: 0,
      content: {
        objectives: '',
        priorKnowledge: '',
        keyPoints: '',
        process: '先比较分母。',
        exercises: '',
        notes: '',
        segments: [],
        sources: [],
      },
    },
  });
  const material = await post('drafts/' + project.id + '/confirm', { expectedRevision: 1 });
  const config = await post('class-configs', {
    projectId: project.id,
    template: 'mixed',
    students: [
      {
        id: 'lin',
        name: '小林',
        priorKnowledge: '椭圆定义',
        expression: 'responsive',
        misconceptions: [],
      },
    ],
    clientRequestId: key(),
  });
  const session = await post('sessions', {
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'text',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 10,
    clientRequestId: key(),
  });
  const first = '长轴沿纵轴。';
  const answer = first + '因为对应的分母更大。';
  let published = '';
  let round = 0;
  let failTts = false;
  let deferTts = false;
  let releaseTts: (() => void) | undefined;
  const requests: Record<string, unknown>[] = [];
  await page.route(`**/sessions/${session.id}/react`, (route) =>
    route.fulfill({
      json: {
        data: {
          id: 'tts_turn_' + ++round,
          status: 'proposed',
          committedLength: 0,
          studentId: 'lin',
          speakerEpoch: 0,
          speech: answer,
          hands: [],
        },
      },
    }),
  );
  await page.route(`**/sessions/${session.id}/deliver`, async (route) => {
    published = answer.slice(0, route.request().postDataJSON().length);
    await route.fulfill({ json: { data: {} } });
  });
  await page.route(`**/sessions/${session.id}/runtime`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (published)
      json.data.events.push({
        ...json.data.events[0],
        id: 'tts_fixture_' + round,
        type: 'student_speech',
        actorType: 'student',
        payload: { studentId: 'lin', text: published, turnId: 'tts_turn_' + round },
      });
    await route.fulfill({ response, json });
  });
  await page.route('**/api/generate/tts', async (route) => {
    requests.push(route.request().postDataJSON());
    if (deferTts)
      await new Promise<void>((resolve) => {
        releaseTts = resolve;
      });
    await route
      .fulfill(
        failTts
          ? { status: 503, json: { error: '受控语音失败' } }
          : { json: { success: true, base64: sampleWav(), format: 'wav' } },
      )
      .catch(() => {});
  });
  await page.goto(`/teacher-training/sessions/${session.id}/classroom`);
  const start = page.getByRole('button', { name: '开始课堂', exact: true });
  await expect(start).toBeEnabled({ timeout: 120_000 });
  await start.click();
  await page.getByRole('button', { name: '学生朗读关', exact: true }).click();
  await expect(page.getByRole('button', { name: '学生朗读开', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const student = page.getByRole('button', { name: '点名小林', exact: true });
  await student.click();
  const audioState = () =>
    page.evaluate(() => {
      const state = (
        window as unknown as {
          trainingAudioFixture: {
            played: number;
            started: number;
            current: HTMLMediaElement | null;
            native: number;
          };
        }
      ).trainingAudioFixture;
      return {
        played: state.played,
        started: state.started,
        paused: state.current?.paused,
        native: state.native,
      };
    });
  await expect.poll(async () => (await audioState()).started).toBe(1);
  expect(requests[0]).toMatchObject({
    ttsProviderId: 'qwen-tts',
    ttsVoice: 'Cherry',
    ttsModelId: 'qwen3-tts-flash',
    text: first,
  });
  expect(requests[0]).not.toHaveProperty('ttsApiKey');
  await expect(page.getByLabel('课堂对话记录')).toContainText(first);
  await expect(page.getByLabel('课堂对话记录')).not.toContainText(answer);
  expect((await audioState()).paused).toBe(false);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await audioState()).paused).toBe(true);
  expect(requests).toHaveLength(1);

  // A failed audio service keeps publishing the existing generated text, without retrying the model.
  failTts = true;
  await page.getByRole('button', { name: '继续课堂', exact: true }).click();
  await student.click();
  await expect(page.getByRole('status').filter({ hasText: '学生文字已保留' })).toBeVisible();
  await expect(page.getByLabel('课堂对话记录')).toContainText(answer);
  await expect(page.getByRole('button', { name: '重试学生回应', exact: true })).not.toBeVisible();
  expect(round).toBe(2);
  expect(requests).toHaveLength(2);

  // Turning narration off also aborts a pending synthesis; its late result must never play.
  failTts = false;
  deferTts = true;
  published = '';
  await student.click();
  await expect.poll(() => requests.length).toBe(3);
  await page.getByRole('button', { name: '学生朗读开', exact: true }).click();
  releaseTts?.();
  await expect(page.getByLabel('课堂对话记录')).toContainText(answer);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect((await audioState()).played).toBe(1);
  expect((await audioState()).native).toBe(0);
  expect(errors).toEqual([]);
});
