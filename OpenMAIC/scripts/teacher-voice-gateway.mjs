import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_BUFFER = 512 * 1024;
const iso = () => new Date().toISOString();

function send(socket, message) {
  if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFER) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function sessionConfig(instructions, voice) {
  return {
    type: 'session.update',
    session: {
      instructions,
      modalities: ['text', 'audio'],
      audio: {
        input: { format: { type: 'pcm', sample_rate: 16_000 } },
        output: { format: { type: 'pcm', sample_rate: 24_000 }, voice },
      },
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      turn_detection: { type: 'semantic_vad', silence_duration_ms: 650 },
    },
  };
}

// The browser reports playback. Only the gateway can write provider transcripts.
export function connectVoiceClient(client, { origin, bridge, connectProvider, voice = 'Tina' }) {
  let ticket;
  let authorization;
  let provider;
  let ready = false;
  let ending = false;
  let claimed = false;
  let checking = false;
  let writes = Promise.resolve();
  let response;
  let inputId;
  let pendingInput;
  const inputs = new Map();
  const outputs = new Map();
  const setup = setTimeout(() => fail('实时语音连接超时。'), 10_000);
  const limit = setTimeout(() => fail('通话已达 5 分钟，请重新点名继续。'), 300_000);
  const heartbeat = setInterval(() => {
    if (!claimed || ending || checking) return;
    checking = true;
    void bridge({ action: 'check', ticket })
      .catch(() => fail('本次点名通话已结束或连接已中断。'))
      .finally(() => {
        checking = false;
      });
  }, 2_000);

  function finish() {
    if (ending) return;
    ending = true;
    clearTimeout(setup);
    clearTimeout(limit);
    clearInterval(heartbeat);
    provider?.close();
    for (const active of outputs.values()) flushPlayback(active, true);
    void Promise.resolve(authorization)
      .catch(() => {})
      .then(async () => {
        await writes;
        if (claimed) await bridge({ action: 'close', ticket }).catch(() => {});
        client.close(1000);
      });
  }

  function fail(message) {
    send(client, { type: 'error', message });
    finish();
  }

  function record(event) {
    writes = writes
      .then(async () => {
        await bridge({ action: 'record', ticket, event });
        send(client, { type: 'saved' });
      })
      .catch(() => fail('通话记录未能保存，已结束通话。'));
  }

  function cut(active, explicit = false) {
    if (!active || active.cut) return;
    active.cut = true;
    send(client, { type: 'cut', id: active.id });
    if (explicit && !active.done) send(provider, { type: 'response.cancel' });
  }

  function flushPlayback(active, closing = false) {
    if (!active.playback || (!closing && active.input && !active.input.final)) return;
    outputs.delete(active.id);
    record(active.playback);
  }

  function playback(message) {
    const active = outputs.get(message.id);
    if (!active || active.playback || !Number.isInteger(message.playedMs) || message.playedMs < 0)
      return;
    const playedMs = Math.min(message.playedMs, Math.round(active.bytes / 48));
    if (message.interrupted === true && playedMs > 0) {
      active.playback = { kind: 'interrupted', eventId: active.id, playedMs, endedAt: iso() };
    } else if (
      message.interrupted === false &&
      active.done &&
      !active.cut &&
      active.text.trim() &&
      playedMs >= Math.floor(active.bytes / 48) &&
      playedMs > 0
    ) {
      active.playback = {
        kind: 'student',
        eventId: active.id,
        text: active.text,
        playedMs,
        endedAt: iso(),
      };
    }
    if (active.playback) flushPlayback(active);
    else if (active.cut || active.done) outputs.delete(active.id);
  }

  function providerMessage(data) {
    if (ending) return;
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'session.updated':
        if (!ready) {
          ready = true;
          clearTimeout(setup);
          send(client, { type: 'ready' });
        }
        break;
      case 'input_audio_buffer.speech_started':
        if (typeof event.item_id !== 'string' || inputs.has(event.item_id)) break;
        // VAD cancels upstream generation. Browser audio may still be buffered.
        for (const active of outputs.values()) cut(active);
        pendingInput = undefined;
        inputId = event.item_id;
        inputs.set(inputId, { id: randomUUID(), startedAt: iso(), final: false });
        if (inputs.size > 32) inputs.delete(inputs.keys().next().value);
        send(client, { type: 'listening' });
        break;
      case 'input_audio_buffer.speech_stopped': {
        const input = inputs.get(event.item_id);
        if (input && event.item_id === inputId && !input.endedAt) {
          input.endedAt = iso();
          pendingInput = input;
          send(client, { type: 'thinking' });
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
        if (event.item_id === inputId)
          send(client, {
            type: 'teacher-caption',
            text: (String(event.text ?? '') + String(event.stash ?? '')).slice(0, 10_000),
          });
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.failed': {
        const input = inputs.get(event.item_id);
        if (!input || input.final) break;
        const text =
          typeof event.transcript === 'string' ? event.transcript.trim().slice(0, 10_000) : '';
        input.final = true;
        if (text)
          record({
            kind: 'teacher',
            eventId: input.id,
            text,
            startedAt: input.startedAt,
            endedAt: input.endedAt ?? iso(),
          });
        if (event.item_id === inputId) send(client, { type: 'teacher-final', text });
        for (const active of outputs.values()) flushPlayback(active);
        break;
      }
      case 'response.created': {
        const providerId = event.response?.id;
        if (
          !ready ||
          !pendingInput ||
          typeof providerId !== 'string' ||
          providerId === response?.providerId
        )
          break;
        if (outputs.size >= 16) return fail('实时语音等待播放的记录过多。');
        if (response && outputs.has(response.id)) cut(response);
        response = {
          id: randomUUID(),
          providerId,
          input: pendingInput,
          bytes: 0,
          text: '',
          cut: false,
          done: false,
        };
        pendingInput = undefined;
        outputs.set(response.id, response);
        send(client, { type: 'response', id: response.id });
        break;
      }
      case 'response.audio.delta':
      case 'response.audio_transcript.delta':
      case 'response.audio_transcript.done':
        if (!response || response.cut || response.done || event.response_id !== response.providerId)
          break;
        if (event.type === 'response.audio.delta' && typeof event.delta === 'string') {
          const length = Buffer.from(event.delta, 'base64').length;
          if (!length || length % 2) break;
          response.bytes += length;
          if (!send(client, { type: 'audio', id: response.id, data: event.delta }))
            fail('语音播放网络拥堵，请重新点名。');
        } else if (event.type !== 'response.audio.delta') {
          response.text = (
            event.type.endsWith('.done')
              ? String(event.transcript ?? response.text)
              : response.text + String(event.delta ?? '')
          ).slice(0, 10_000);
          send(client, { type: 'student-caption', id: response.id, text: response.text });
        }
        break;
      case 'response.done':
        if (!response || event.response?.id !== response.providerId || response.cut) break;
        response.done = true;
        if (event.response.status === 'completed' && response.bytes > 0)
          send(client, { type: 'response-end', id: response.id });
        else {
          cut(response);
          send(client, { type: 'notice', message: '学生回答未完成，请继续提问。' });
        }
        break;
      case 'error':
        if (
          response?.cut &&
          ['response_cancel_not_active', 'response_not_active'].includes(event.error?.code)
        )
          break;
        fail('百炼实时语音暂不可用，请检查工作空间、模型权限和额度。');
        break;
    }
  }

  async function authorize(message) {
    if (
      message.type !== 'start' ||
      typeof message.ticket !== 'string' ||
      message.ticket.length > 2_048
    )
      return fail('通话凭证无效。');
    ticket = message.ticket;
    try {
      const grant = await bridge({ action: 'claim', origin, ticket });
      claimed = true;
      if (ending) return;
      provider = connectProvider();
      provider.on('message', providerMessage);
      provider.once('open', () => send(provider, sessionConfig(grant.instructions, voice)));
      provider.on('error', () => {
        if (!ending) fail('无法连接百炼实时语音。');
      });
      provider.once('close', () => {
        if (!ending) fail('百炼实时语音连接已断开。');
      });
    } catch {
      fail('通话凭证无效或点名已变更，请重新点名。');
    }
  }

  client.on('message', (data, binary) => {
    if (ending) return;
    if (binary) {
      if (!ready || !data.length || data.length % 2 || data.length > 3_200) return;
      if (!send(provider, { type: 'input_audio_buffer.append', audio: data.toString('base64') }))
        fail('语音上传网络拥堵，请重新点名。');
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (!authorization) {
      authorization = authorize(message);
      return;
    }
    if (message.type === 'played') playback(message);
    if (message.type === 'interrupt' && response?.id === message.id) cut(response, true);
    if (message.type === 'hangup') finish();
  });
  client.on('error', finish);
  client.once('close', finish);
}

function startGateway() {
  const key = process.env.TEACHER_VOICE_QWEN_API_KEY?.trim();
  const workspace = process.env.TEACHER_VOICE_QWEN_WORKSPACE?.trim();
  const secret = process.env.TEACHER_VOICE_BRIDGE_SECRET?.trim();
  if (!key || !workspace || !/^[a-z0-9-]+$/i.test(workspace) || !secret || secret.length < 32)
    throw new Error('请配置实时语音工作空间、百炼 API Key 和至少 32 字符的网关密钥。');
  const app = process.env.TEACHER_VOICE_APP_URL || 'http://localhost:3000';
  const port = Number(process.env.TEACHER_VOICE_PORT || 9041);
  const region =
    process.env.TEACHER_VOICE_QWEN_REGION === 'singapore' ? 'ap-southeast-1' : 'cn-beijing';
  const upstream = new URL(`wss://${workspace}.${region}.maas.aliyuncs.com/api-ws/v1/realtime`);
  upstream.searchParams.set('model', 'qwen3.5-omni-flash-realtime');
  const bridgeUrl = new URL('/api/teacher-training/voice-bridge', app);
  const bridge = async (body) => {
    const result = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-training-voice-secret': secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
    if (!result.ok) throw new Error('Voice bridge rejected request');
    return (await result.json()).data;
  };
  const server = createServer((_request, res) => res.writeHead(404).end());
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024,
    perMessageDeflate: false,
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/voice' || !request.headers.origin || sockets.clients.size >= 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      connectVoiceClient(client, {
        origin: request.headers.origin,
        bridge,
        connectProvider: () =>
          new WebSocket(upstream, {
            headers: { Authorization: `Bearer ${key}` },
            handshakeTimeout: 8_000,
            maxPayload: 1024 * 1024,
            perMessageDeflate: false,
          }),
        voice: process.env.TEACHER_VOICE_QWEN_VOICE?.trim() || 'Tina',
      });
    });
  });
  server.listen(port, process.env.TEACHER_VOICE_HOST || '127.0.0.1', () => {
    console.log(`Teacher voice gateway listening on port ${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startGateway();
