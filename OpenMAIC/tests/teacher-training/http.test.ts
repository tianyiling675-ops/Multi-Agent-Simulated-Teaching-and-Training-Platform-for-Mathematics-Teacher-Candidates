import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { handleTrainingRequest } from '@/lib/teacher-training/http';
import { SqliteTrainingStore } from '@/lib/teacher-training/sqlite-store';

const store = new SqliteTrainingStore(':memory:');
afterAll(() => store.close());
const url = 'http://localhost:3002/api/teacher-training/';
function send(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return handleTrainingRequest(
    new Request(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    path.split('/'),
    async () => store,
  );
}

describe('training HTTP boundary', () => {
  it('issues a private device credential, persists on retry, and rejects another device', async () => {
    const boot = await send('capabilities');
    const setCookie = boot.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const cookie = setCookie.split(';')[0];
    const create = await send(
      'projects',
      { title: '代数', grade: '初中', scope: '方程', clientRequestId: randomUUID() },
      cookie,
    );
    expect(create.status).toBe(201);
    const project = (await create.json()).data;
    expect((await send(`projects/${project.id}`, undefined, cookie)).status).toBe(200);
    expect((await send(`projects/${project.id}`)).status).toBe(404);
    expect(
      (await send(`projects/${project.id}`, undefined, undefined, { 'x-learner-key': cookie }))
        .status,
    ).toBe(404);
    expect(create.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(project)).not.toContain('device:');
  });

  it('rejects owner injection and cross-origin mutation', async () => {
    const body = { title: '代数', grade: '初中', scope: '方程', clientRequestId: randomUUID() };
    expect((await send('projects', { ...body, ownerId: 'victim' })).status).toBe(400);
    expect(
      (await send('projects', body, undefined, { origin: 'https://elsewhere.example' })).status,
    ).toBe(403);
    expect(
      (await send('projects', body, undefined, { 'sec-fetch-site': 'cross-site' })).status,
    ).toBe(403);
  });

  it('accepts the browser Host when Next.js normalizes the internal URL to localhost', async () => {
    const response = await send(
      'projects',
      { title: '椭圆', grade: '高中', scope: '概念', clientRequestId: randomUUID() },
      undefined,
      {
        host: '127.0.0.1:3002',
        origin: 'http://127.0.0.1:3002',
        'sec-fetch-site': 'same-origin',
      },
    );
    expect(response.status).toBe(201);
  });

  it.each<Record<string, string>>([
    { origin: 'http://localhost:3002' },
    { origin: 'http://127.0.0.1:3003' },
    { origin: 'https://127.0.0.1:3002' },
    { origin: 'null' },
    { origin: 'http://127.0.0.1:3002', 'sec-fetch-site': 'cross-site' },
    {
      origin: 'https://elsewhere.example',
      'x-forwarded-host': 'elsewhere.example',
      'x-forwarded-proto': 'https',
    },
  ])('rejects a different browser origin or cross-site request: %j', async (headers) => {
    const response = await send(
      'projects',
      { title: '椭圆', grade: '高中', scope: '概念', clientRequestId: randomUUID() },
      undefined,
      { host: '127.0.0.1:3002', ...headers },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('ORIGIN_REJECTED');
  });

  it('fails closed when storage is unavailable and still retains identity on the error response', async () => {
    const response = await handleTrainingRequest(
      new Request(url + 'projects'),
      ['projects'],
      async () => {
        throw new Error('private connection string');
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toContain('training_identity');
    const body = await response.json();
    expect(body.retryable).toBe(true);
    expect(JSON.stringify(body)).not.toContain('private connection');
  });

  it('does not offer a candidate rubric as a published scoring standard', async () => {
    expect((await (await send('rubrics')).json()).data).toEqual([]);
    expect((await send('sessions/invalid/analyses', {})).status).toBe(404);
    expect((await send('projects', { title: 'a'.repeat(600_100) })).status).toBe(413);
  });
});
