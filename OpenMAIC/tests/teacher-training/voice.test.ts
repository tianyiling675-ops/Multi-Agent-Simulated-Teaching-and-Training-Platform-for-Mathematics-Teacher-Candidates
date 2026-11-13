import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { connectVoiceClient } from '../../scripts/teacher-voice-gateway.mjs';
import { handleTrainingRequest } from '@/lib/teacher-training/http';
import { emptyMaterial } from '@/lib/teacher-training/contracts';
import { SqliteTrainingStore } from '@/lib/teacher-training/sqlite-store';
import { TrainingService } from '@/lib/teacher-training/service';
import { trainingOwner } from '@/lib/teacher-training/identity';
import { openTeacherVoice } from '@/lib/teacher-training/voice-client';

const origin = 'http://localhost:3000';
const secret = 'test-voice-bridge-secret-with-32-characters';
const cookie = `training_identity=${'a'.repeat(64)}`;
const stores: SqliteTrainingStore[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.close();
});

it('stops the browser audio queue on barge-in and releases the microphone on hangup', async () => {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const sourceNode = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  });
  const nodes: ReturnType<typeof sourceNode>[] = [];
  const clock = { currentTime: 0 };
  const workletPort = { onmessage: null as ((event: { data: ArrayBuffer }) => void) | null };
  class Audio {
    get currentTime() {
      return clock.currentTime;
    }
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    async resume() {}
    async close() {}
    getOutputTimestamp() {
      return { contextTime: clock.currentTime };
    }
    createMediaStreamSource() {
      return sourceNode();
    }
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      const node = sourceNode();
      nodes.push(node);
      return node;
    }
  }
  class Worklet {
    port = workletPort;
    connect() {}
    disconnect() {}
  }
  const sockets: BrowserSocket[] = [];
  class BrowserSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent: (Packet | ArrayBuffer)[] = [];
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(message: string | ArrayBuffer) {
      if (typeof message !== 'string') {
        this.sent.push(message);
        return;
      }
      const parsed = JSON.parse(message);
      this.sent.push(parsed);
      if (parsed.type === 'hangup') this.close();
    }
    receive(message: Packet) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
    },
  });
  vi.stubGlobal('AudioContext', Audio);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.stubGlobal('WebSocket', BrowserSocket);

  const closed = vi.fn();
  const client = openTeacherVoice(
    async () => ({ url: 'ws://localhost:9041/voice', ticket: 'ticket' }),
    { update: vi.fn(), saved: vi.fn(), notice: vi.fn(), closed },
  );
  try {
    await vi.waitFor(() =>
      expect(sockets[0]?.sent).toContainEqual({ type: 'start', ticket: 'ticket' }),
    );
    const socket = sockets[0];
    socket.receive({ type: 'ready' });
    const mic = new ArrayBuffer(640);
    workletPort.onmessage?.({ data: mic });
    expect(socket.sent).toContain(mic);

    const pcm = Buffer.alloc(4_800).toString('base64');
    socket.receive({ type: 'response', id: 'first' });
    socket.receive({ type: 'audio', id: 'first', data: pcm });
    clock.currentTime = 0.08;
    socket.receive({ type: 'cut', id: 'first' });
    socket.receive({ type: 'audio', id: 'first', data: pcm });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].stop).toHaveBeenCalledOnce();
    expect(socket.sent).toContainEqual({
      type: 'played',
      id: 'first',
      playedMs: 45,
      interrupted: true,
    });

    socket.receive({ type: 'response', id: 'second' });
    socket.receive({ type: 'audio', id: 'second', data: pcm });
    socket.receive({ type: 'response-end', id: 'second' });
    nodes[1].onended?.();
    await vi.waitFor(() =>
      expect(socket.sent).toContainEqual({
        type: 'played',
        id: 'second',
        playedMs: 100,
        interrupted: false,
      }),
    );
  } finally {
    await client.stop();
  }
  expect(track.stop).toHaveBeenCalledOnce();
  expect(closed).toHaveBeenCalledWith(undefined);
});

async function fixture() {
  vi.stubEnv('TEACHER_VOICE_BRIDGE_SECRET', secret);
  vi.stubEnv('TEACHER_VOICE_WS_URL', 'ws://localhost:9041/voice');
  const store = new SqliteTrainingStore(':memory:');
  stores.push(store);
  const request = (path: string, body?: unknown, headers?: Record<string, string>) =>
    new Request(`${origin}/api/teacher-training/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const send = (path: string, body?: unknown, headers?: Record<string, string>) =>
    handleTrainingRequest(request(path, body, headers), path.split('/'), async () => store);
  const owner = trainingOwner(request('voice-status'), new Headers());
  const service = new TrainingService(store, owner);
  const project = await service.createProject({
    title: '方程',
    grade: '高一',
    scope: '除式',
    clientRequestId: randomUUID(),
  });
  await service.saveDraft(project.id, {
    expectedRevision: 0,
    content: { ...emptyMaterial(), process: '教案私有', notes: '教师备注私有' },
  });
  const material = await service.confirmDraft(project.id, { expectedRevision: 1 });
  const config = await service.createClass({
    projectId: project.id,
    template: 'mixed',
    clientRequestId: randomUUID(),
    students: [
      {
        id: 'lin',
        name: '小林',
        expression: 'responsive',
        priorKnowledge: '方程基础',
        misconceptions: ['忽略分母非零'],
      },
      {
        id: 'wang',
        name: '小王',
        expression: 'reserved',
        priorKnowledge: '',
        misconceptions: ['另一位学生的私有画像'],
      },
    ],
  });
  const session = await service.createSession({
    projectId: project.id,
    materialVersionId: material.id,
    classConfigVersionId: config.id,
    inputMode: 'mixed',
    assistance: 'independent',
    scope: 'full',
    plannedMinutes: 15,
    clientRequestId: randomUUID(),
  });
  const command = async (body: object) => {
    const { session: current } = await service.getRuntime(session.id);
    return service.command(session.id, {
      ...body,
      expectedRevision: current.revision,
      clientEventId: randomUUID(),
    });
  };
  await command({ command: 'start' });
  const call = async (studentId: string) => {
    const { event } = await command({ command: 'call_on', studentId, voice: true });
    const result = await send(`sessions/${session.id}/voice-ticket`, { triggerId: event.id });
    expect(result.status).toBe(200);
    return (await result.json()).data.ticket as string;
  };
  const bridgeRequest = (body: object) =>
    send('voice-bridge', body, { 'x-training-voice-secret': secret });
  const bridge = async (body: object) => {
    const response = await bridgeRequest(body);
    if (!response.ok) throw new Error(`bridge returned ${response.status}`);
    return (await response.json()).data;
  };
  return { session, service, send, bridge, bridgeRequest, call, command };
}

it('claims a point-named student once, preserves the floor across writes, and rejects the old call after switching', async () => {
  const f = await fixture();
  const ticket = await f.call('lin');
  const claim = { action: 'claim', origin, ticket };
  expect((await f.send('voice-bridge', claim)).status).toBe(403);
  expect((await f.bridgeRequest({ ...claim, origin: 'https://different.example' })).status).toBe(
    403,
  );
  const { instructions } = await f.bridge(claim);
  expect(instructions).toContain('忽略分母非零');
  expect(instructions).not.toMatch(/另一位学生的私有画像|教师备注私有|教案私有/);
  expect((await f.bridgeRequest(claim)).status).toBe(409);
  const before = await f.service.getRuntime(f.session.id);
  const first = {
    action: 'record',
    ticket,
    event: { kind: 'teacher', eventId: randomUUID(), text: '什么时候可以除？' },
  };
  await f.bridge(first);
  await f.bridge(first);
  const after = await f.service.getRuntime(f.session.id);
  expect(after.events).toHaveLength(before.events.length + 1);
  expect(after.session.speakerEpoch).toBe(before.session.speakerEpoch);
  expect(after.classroom.activeStudentId).toBe('lin');
  await f.call('wang');
  expect((await f.bridgeRequest({ action: 'check', ticket })).status).toBe(409);
  const late = { ...first, event: { ...first.event, eventId: randomUUID() } };
  expect((await f.bridgeRequest(late)).status).toBe(409);
});

type Packet = { type: string; id?: string; data?: string; text?: string };

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Packet[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  receive(data: object) {
    this.emit('message', Buffer.from(JSON.stringify(data)), false);
  }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
  }
}

it('runs consecutive voice turns, excludes late audio after interruption, and stores only played replies', async () => {
  const f = await fixture();
  const ticket = await f.call('lin');
  const client = new Socket();
  const provider = new Socket();
  const pcm = Buffer.alloc(4_800).toString('base64');
  connectVoiceClient(client, { origin, bridge: f.bridge, connectProvider: () => provider });
  try {
    client.receive({ type: 'start', ticket });
    await vi.waitFor(() => expect(provider.listenerCount('open')).toBe(1));
    provider.emit('open');
    expect(provider.sent[0].type).toBe('session.update');
    provider.receive({ type: 'session.updated' });
    expect(client.sent.at(-1)?.type).toBe('ready');
    client.emit('message', Buffer.alloc(640), true);
    expect(provider.sent.at(-1)?.type).toBe('input_audio_buffer.append');

    const speak = (item: string) =>
      provider.receive({
        type: 'input_audio_buffer.speech_started',
        item_id: item,
      });
    const answer = (item: string, id: string, question: string) => {
      provider.receive({ type: 'input_audio_buffer.speech_stopped', item_id: item });
      provider.receive({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: item,
        transcript: question,
      });
      provider.receive({ type: 'response.created', response: { id } });
      const localId = client.sent.at(-1)?.id;
      expect(client.sent.at(-1)?.type).toBe('response');
      provider.receive({ type: 'response.audio.delta', response_id: id, delta: pcm });
      provider.receive({
        type: 'response.audio_transcript.done',
        response_id: id,
        transcript: `学生回答 ${id}`,
      });
      return localId;
    };
    speak('question-1');
    const first = answer('question-1', 'first', '可以直接除吗？');
    const audioCount = client.sent.filter((packet) => packet.type === 'audio').length;
    speak('question-2');
    expect(client.sent).toContainEqual({ type: 'cut', id: first });
    provider.receive({ type: 'response.audio.delta', response_id: 'first', delta: pcm });
    provider.receive({ type: 'response.done', response: { id: 'first', status: 'completed' } });
    expect(client.sent.filter((packet) => packet.type === 'audio')).toHaveLength(audioCount);
    client.receive({ type: 'played', id: first, interrupted: true, playedMs: 40 });

    const second = answer('question-2', 'second', '等等，先看分母。');
    provider.receive({ type: 'response.done', response: { id: 'second', status: 'completed' } });
    client.receive({ type: 'played', id: second, interrupted: false, playedMs: 100 });
    client.receive({ type: 'played', id: second, interrupted: false, playedMs: 100 });
    speak('question-3');
    const third = answer('question-3', 'third', '请再解释一次。');
    provider.receive({ type: 'response.done', response: { id: 'third', status: 'completed' } });
    client.receive({ type: 'played', id: third, interrupted: false, playedMs: 100 });
    client.receive({ type: 'hangup' });

    await vi.waitFor(() => expect(client.readyState).toBe(3));
    const detail = await f.service.getRuntime(f.session.id);
    expect(detail.classroom.activeStudentId).toBeNull();
    const events = detail.events.filter((event) => event.payload.voice);
    expect(events.map(({ type }) => type)).toEqual([
      'teacher_text',
      'voice_interrupted',
      'teacher_text',
      'student_speech',
      'teacher_text',
      'student_speech',
    ]);
    expect(events[1].payload.voice?.playedMs).toBe(40);
    expect(events[1].payload.text).toBeUndefined();
    expect(events[3].payload).toMatchObject({ studentId: 'lin', text: '学生回答 second' });
  } finally {
    client.close();
  }
});
