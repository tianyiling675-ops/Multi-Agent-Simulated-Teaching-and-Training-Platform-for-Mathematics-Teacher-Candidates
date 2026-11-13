'use client';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
export async function trainingApi<T>(
  path: string,
  body?: unknown,
  options: {
    method?: string;
    signal?: AbortSignal;
    model?: boolean;
    timeoutMs?: number;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const config = options.model ? getCurrentModelConfig() : null;
  const response = await fetch(`/api/teacher-training/${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    cache: 'no-store',
    keepalive: options.keepalive,
    signal: AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeoutMs ?? (options.model ? 240_000 : 45_000)),
    ]),
    headers: {
      'Content-Type': 'application/json',
      ...(config
        ? {
            'x-model': config.modelString,
            'x-api-key': config.apiKey,
            'x-base-url': config.baseUrl,
            'x-provider-type': config.providerType ?? '',
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.message || '请求失败，请保留输入后重试。'), {
      code: result.code,
    });
  return result.data as T;
}
export const classroomHref = (sessionId: string) =>
  `/teacher-training/sessions/${encodeURIComponent(sessionId)}/classroom`;
export const recordsHref = (projectId: string, sessionId: string) =>
  `/teacher-training?project=${encodeURIComponent(projectId)}&tab=records&session=${encodeURIComponent(sessionId)}`;
