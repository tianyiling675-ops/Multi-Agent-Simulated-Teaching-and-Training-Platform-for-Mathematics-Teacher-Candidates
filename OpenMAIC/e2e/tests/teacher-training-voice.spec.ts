import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { connectVoiceClient } from '../../scripts/teacher-voice-gateway.mjs';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream'] } });

test('point-named voice call plays, interrupts, switches students and feeds the review', async ({
  page,
  context,
}) => {
  const bridgeSecret = process.env.TEACHER_VOICE_BRIDGE_SECRET;
  test.skip(
    !bridgeSecret || !process.env.TEACHER_VOICE_WS_URL,
    'Run with the voice test gateway configuration.',
  );
  await context.grantPermissions(['microphone']);
  const request = page.request;
  const prefix = '/api/teacher-training/';
  const post = async (path: string, data: object, headers?: Record<string, string>) => {
    const response = await request.post(prefix + path, { data, headers });
    const result = await response.json();
    expect(response.ok(), JSON.stringify(result)).toBeTruthy();
    return result.data;
  };
  const { data: status } = await (await request.get(prefix + 'voice-status')).json();
  expect(status.configured).toBe(true);
  const project = await post('projects', {
    title: '实时点名验收',
    grade: '高一',
    scope: '方程',
    clientRequestId: randomUUID(),
  });
  await expect(
    await request.patch(prefix + `drafts/${project.id}`, {
      data: {
        expectedRevision: 0,
        content: {
          objectives: '',
          priorKnowledge: '',
          keyPoints: '',
          process: '讲解分母非零',
          exercises: '',
          notes: '',
          segments: [],
          sources: [],
        },
      },
    }),
  ).toBeOK();
  const material = await post(`drafts/${project.id}/confirm`, { expectedRevision: 1 });
  const config = await post('class-configs', {
    projectId: project.id,
    template: 'mixed',
    students: [
      { id: 'lin', name: '小林', expression: 'responsive', priorKnowledge: '', misconceptions: [] },
      { id: 'wang', name: '小王', expression: 'reserved', priorKnowledge: '', misconceptions: [] },
    ],
    clientRequestId: randomUUID(),
  });
  const session = await post('sessions', {
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'mixed',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 15,
    clientRequestId: randomUUID(),
  });
  const providers: Provider[] = [];
  class Provider extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    micFrames = 0;
    send(data: string) {
      const message = JSON.parse(data);
      if (message.type === 'session.update') this.receive({ type: 'session.updated' });
      if (message.type === 'input_audio_buffer.append') this.micFrames++;
    }
    receive(message: object) {
      this.emit('message', Buffer.from(JSON.stringify(message)));
    }
    close() {
      this.emit('close');
    }
  }
  await page.routeWebSocket('**/voice', (route) => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string) => route.send(data),
      close() {
        if (this.readyState !== 1) return;
        this.readyState = 3;
        void route.close({ code: 1000 });
      },
    });
    route.onMessage((data) => socket.emit('message', Buffer.from(data), typeof data !== 'string'));
    route.onClose(() => {
      socket.readyState = 3;
      socket.emit('close');
    });
    connectVoiceClient(socket, {
      origin: new URL(page.url()).origin,
      bridge: (body: object) =>
        post('voice-bridge', body, { 'x-training-voice-secret': bridgeSecret! }),
      connectProvider: () => {
        const provider = new Provider();
        providers.push(provider);
        queueMicrotask(() => provider.emit('open'));
        return provider;
      },
    });
  });
  await page.goto(`/teacher-training/sessions/${session.id}/classroom`);
  await page.getByRole('button', { name: '开始课堂' }).click();
  await page.getByRole('button', { name: /实时点名关/ }).click();
  await page.getByRole('button', { name: '点名小林' }).click();
  const panel = page.getByLabel('点名实时通话');
  await expect(panel).toContainText('麦克风已开启');
  await expect.poll(() => providers[0]?.micFrames).toBeGreaterThan(0);

  const provider = providers[0];
  const start = (item: string) =>
    provider.receive({ type: 'input_audio_buffer.speech_started', item_id: item });
  const answer = (item: string, id: string, ms: number) => {
    provider.receive({ type: 'input_audio_buffer.speech_stopped', item_id: item });
    provider.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: item,
      transcript: `教师提问 ${item}`,
    });
    provider.receive({ type: 'response.created', response: { id } });
    provider.receive({
      type: 'response.audio.delta',
      response_id: id,
      delta: Buffer.alloc(48 * ms).toString('base64'),
    });
    provider.receive({
      type: 'response.audio_transcript.done',
      response_id: id,
      transcript: `学生语音 ${id}`,
    });
  };
  start('第一轮');
  answer('第一轮', 'cut', 1_000);
  await expect(panel).toContainText('学生正在回答');
  await page.waitForTimeout(220); // Let the scheduled PCM actually start before simulating a barge-in.
  start('第二轮');
  await expect(panel).toContainText('正在听你说话');
  answer('第二轮', 'complete', 150);
  provider.receive({ type: 'response.done', response: { id: 'complete', status: 'completed' } });
  const events = async () =>
    (await (await request.get(prefix + `sessions/${session.id}/runtime`)).json()).data.events;
  await expect
    .poll(async () =>
      (await events()).some(
        (event: { type: string; payload: { text?: string } }) =>
          event.type === 'student_speech' && event.payload.text === '学生语音 complete',
      ),
    )
    .toBe(true);

  await page.getByRole('button', { name: '点名小王' }).click();
  await expect(panel).toContainText('小王 · 实时通话');
  await expect.poll(() => providers[1]?.micFrames).toBeGreaterThan(0);
  await page.getByRole('button', { name: '收回发言' }).click();
  await expect(panel).toHaveCount(0);
  await page.goto(`/teacher-training?project=${project.id}&tab=records&session=${session.id}`);
  await expect(page.getByLabel('课堂事件记录')).toContainText('学生语音被打断');
  await expect(page.getByLabel('课堂事件记录')).toContainText('打断前约播放');
  await expect(page.getByLabel('课堂事件记录')).toContainText('学生语音 complete');
  await expect(page.getByLabel('课堂事件记录')).not.toContainText('学生语音 cut');
});
