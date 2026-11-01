import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { TrainingError } from './contracts';
import { trainingOwner } from './identity';
import { TrainingService } from './service';
import type { TrainingStore } from './store';
import { getTrainingStore, trainingStorageMode } from './server-store';

const MAX_BODY = 600_000;
async function readBody(request: Request, limit = MAX_BODY): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new TrainingError('INVALID_REQUEST', '请求必须为 JSON。', 415);
  if (Number(request.headers.get('content-length')) > limit)
    throw new TrainingError('REQUEST_TOO_LARGE', '提交内容超过当前限制。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new TrainingError('INVALID_REQUEST', '请求内容为空。');
  const decoder = new TextDecoder();
  let size = 0;
  let raw = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new TrainingError('REQUEST_TOO_LARGE', '提交内容超过当前限制。', 413);
      }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
    try {
      return JSON.parse(raw);
    } catch {
      throw new TrainingError('INVALID_REQUEST', 'JSON 内容无效。');
    }
  } finally {
    reader.releaseLock();
  }
}

export async function handleTrainingRequest(
  request: Request,
  path: string[],
  resolveStore: () => Promise<TrainingStore> = getTrainingStore,
): Promise<Response> {
  const requestId = randomUUID();
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Cookie' });
  const ownerId = trainingOwner(request, headers);
  const respond = (data: unknown, status = 200) => {
    const record = data as {
      revision?: number;
      session?: { revision: number };
      draft?: { revision: number };
    } | null;
    const revision =
      record?.revision ?? record?.session?.revision ?? record?.draft?.revision ?? null;
    return Response.json({ data, requestId, revision }, { status, headers });
  };
  try {
    const method = request.method;
    if (method !== 'GET') {
      const origin = request.headers.get('origin');
      const requestUrl = new URL(request.url);
      // Next.js may normalize the internal URL to localhost even when the
      // browser uses 127.0.0.1. Host identifies the authority actually requested
      // by the browser; do not trust client-supplied forwarding headers here.
      const host = request.headers.get('host');
      const expectedOrigin = host
        ? new URL(`${requestUrl.protocol}//${host}`).origin
        : requestUrl.origin;
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (origin && origin !== expectedOrigin)
      ) {
        throw new TrainingError('ORIGIN_REJECTED', '请从当前站点提交操作。', 403);
      }
    }
    if (path.some((part) => !/^[a-zA-Z0-9_-]{1,100}$/.test(part)))
      throw new TrainingError('NOT_FOUND', '接口不存在。', 404);
    if (method === 'GET' && path.join('/') === 'capabilities') {
      await resolveStore(); // Refuse a misleading "ready" if storage failed to initialize.
      const { documentConverterCapability } = await import('./document-converter');
      return respond({
        storage: trainingStorageMode(),
        identity: 'device',
        phase: 'teacher_classroom',
        documentConversion: await documentConverterCapability(),
        available: [
          'text_preparation',
          'immutable_versions',
          'class_configuration',
          'teacher_text',
          'session_control',
          'slide_preparation',
          'whiteboard',
          'student_simulation',
        ],
        pending: ['voice_evidence', 'evaluation', 'revision_proposals', 'rehearsal'],
      });
    }
    const store = await resolveStore();
    const service = new TrainingService(store, ownerId);
    const [resource, id, action] = path;
    if (method === 'POST' && resource === 'materials' && id === 'extract' && path.length === 2) {
      const { extractTrainingFile } = await import('./extract');
      return respond(await extractTrainingFile(request));
    }
    if (method === 'GET') {
      if (resource === 'projects' && path.length === 1)
        return respond(await service.listProjects());
      if (resource === 'projects' && path.length === 2)
        return respond(await service.getProject(id));
      if (resource === 'sessions' && path.length === 2)
        return respond(await service.getSession(id));
      if (resource === 'sessions' && action === 'runtime' && path.length === 3)
        return respond(await service.getRuntime(id));
      if (resource === 'rubrics' && path.length === 1) return respond([]);
    }
    const body =
      method === 'GET'
        ? undefined
        : await readBody(request, resource === 'drafts' ? 32 * 1024 * 1024 : MAX_BODY);
    if (method === 'POST') {
      if (resource === 'projects' && action === 'generate' && path.length === 3) {
        const { PreparationService } = await import('./preparation-service');
        return respond(await new PreparationService(store, ownerId).begin(id, body, request));
      }
      if (resource === 'preparations' && action === 'page' && path.length === 3) {
        const { PreparationService } = await import('./preparation-service');
        return respond(await new PreparationService(store, ownerId).page(id, body, request));
      }
      if (resource === 'sessions' && ['react', 'deliver'].includes(action) && path.length === 3) {
        const { ClassroomService } = await import('./classroom-service');
        const classroom = new ClassroomService(store, ownerId);
        if (action === 'deliver') return respond(await classroom.deliver(id, body));
        const { studentGenerator } = await import('./model');
        return respond(await classroom.react(id, body, studentGenerator(request), request.signal));
      }
      if (resource === 'projects' && path.length === 1)
        return respond(await service.createProject(body), 201);
      if (resource === 'class-configs' && path.length === 1)
        return respond(await service.createClass(body), 201);
      if (resource === 'sessions' && path.length === 1)
        return respond(await service.createSession(body), 201);
      if (resource === 'drafts' && action === 'confirm' && path.length === 3)
        return respond(await service.confirmDraft(id, body));
      if (resource === 'sessions' && action === 'commands' && path.length === 3)
        return respond(await service.command(id, body));
      if (resource === 'sessions' && action === 'events' && path.length === 3)
        return respond(await service.submitEvent(id, body));
    }
    if (
      method === 'PATCH' &&
      resource === 'preparations' &&
      action === 'outline' &&
      path.length === 3
    ) {
      const { PreparationService } = await import('./preparation-service');
      return respond(await new PreparationService(store, ownerId).revise(id, body));
    }
    if (method === 'PATCH' && resource === 'drafts' && path.length === 2)
      return respond(await service.saveDraft(id, body));
    throw new TrainingError('NOT_FOUND', '接口不存在或尚未接入。', 404);
  } catch (error) {
    const known =
      error instanceof TrainingError
        ? error
        : error instanceof ZodError
          ? new TrainingError(
              'INVALID_REQUEST',
              '提交内容不符合要求。',
              400,
              error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
            )
          : new TrainingError(
              'STORAGE_UNAVAILABLE',
              '记录未能保存或读取，请稍后重试；保留当前输入。',
              503,
            );
    return Response.json(
      {
        code: known.code,
        message: known.message,
        retryable: known.status >= 500,
        details: known.details,
        requestId,
      },
      { status: known.status, headers },
    );
  }
}
