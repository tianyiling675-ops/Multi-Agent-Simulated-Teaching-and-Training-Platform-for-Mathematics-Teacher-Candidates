import { TrainingError } from './contracts';
import { documentResultSchema, type DocumentResult } from './document-contracts';

const TIMEOUT = 75_000;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

function converterUrl() {
  const configured = process.env.DOCUMENT_CONVERTER_URL?.trim();
  return (
    configured?.replace(/\/+$/, '') ||
    (process.env.NODE_ENV !== 'production' ? 'http://127.0.0.1:9040' : null)
  );
}
function serviceHeaders(): Record<string, string> {
  const token = process.env.DOCUMENT_CONVERTER_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export async function documentConverterCapability() {
  const url = converterUrl();
  if (!url) return { enabled: false, formulaHandling: 'deferred' as const };
  try {
    const response = await fetch(`${url}/health`, {
      headers: serviceHeaders(),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    const body = response.ok ? await response.json() : null;
    return {
      enabled: body?.status === 'ok' && body?.adapterVersion === 'openmaic-documents-v1',
      formulaHandling: 'deferred' as const,
    };
  } catch {
    return { enabled: false, formulaHandling: 'deferred' as const };
  }
}
async function readResult(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty conversion response');
  const decoder = new TextDecoder();
  let raw = '',
    size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESULT_BYTES) {
        await reader.cancel();
        throw new Error('Oversized conversion response');
      }
      raw += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
export async function convertDocument(
  bytes: Uint8Array,
  format: 'docx' | 'pdf',
  signal: AbortSignal,
): Promise<DocumentResult> {
  const url = converterUrl();
  if (!url)
    throw new TrainingError(
      'DOCUMENT_SERVICE_UNAVAILABLE',
      'Word／PDF 转换服务尚未配置，请启动文档转换服务。',
      503,
    );
  try {
    // Only operator configuration supplies the host. Fixed-format endpoints
    // accept uploaded bytes, never user-provided URLs or filesystem paths.
    const response = await fetch(`${url}/convert/${format}`, {
      method: 'POST',
      headers: { ...serviceHeaders(), 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes).buffer,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
    });
    const result = await readResult(response);
    if (!response.ok) {
      const known = result as { code?: string; message?: string };
      const allowed = [
        'MATERIAL_INVALID',
        'MATERIAL_UNSUPPORTED',
        'MATERIAL_LIMIT_EXCEEDED',
        'MATERIAL_EMPTY',
        'MATERIAL_ENCRYPTED',
        'OCR_REQUIRED',
        'DOCUMENT_TIMEOUT',
        'DOCUMENT_BUSY',
      ];
      if (known.code && allowed.includes(known.code) && typeof known.message === 'string')
        throw new TrainingError(
          known.code,
          known.message.slice(0, 1000),
          response.status >= 500 ? 503 : 400,
        );
      throw new TrainingError(
        'DOCUMENT_CONVERSION_FAILED',
        '文档转换未完成，请检查文件后重试。',
        502,
      );
    }
    const parsed = documentResultSchema.safeParse(result);
    if (
      !parsed.success ||
      parsed.data.format !== format ||
      parsed.data.text !== parsed.data.markdown
    )
      throw new TrainingError(
        'DOCUMENT_CONVERSION_FAILED',
        '转换服务返回的数据不完整，请重试。',
        502,
      );
    return parsed.data;
  } catch (error) {
    if (error instanceof TrainingError) throw error;
    if (signal.aborted) throw new TrainingError('DOCUMENT_CANCELLED', '本次导入已取消。', 409);
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      throw new TrainingError(
        'DOCUMENT_TIMEOUT',
        '文档转换超时，原有草稿保留。请拆分文件后重试。',
        504,
      );
    throw new TrainingError(
      'DOCUMENT_SERVICE_UNAVAILABLE',
      'Word／PDF 转换服务暂时不可用，请确认服务已启动后重试。',
      503,
    );
  }
}
