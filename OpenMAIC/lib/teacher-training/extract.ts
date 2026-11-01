import { createHash } from 'node:crypto';
import { TrainingError } from './contracts';
import { DOCUMENT_FILE_LIMIT, type DocumentResult } from './document-contracts';
import { convertDocument } from './document-converter';

type Converter = typeof convertDocument;
export async function extractTrainingFile(
  request: Request,
  convert: Converter = convertDocument,
): Promise<DocumentResult> {
  const multipartLimit = DOCUMENT_FILE_LIMIT + 1024 * 1024;
  if (Number(request.headers.get('content-length')) > multipartLimit)
    throw new TrainingError('MATERIAL_LIMIT_EXCEEDED', '当前单份文件上限为8 MiB。', 413);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data'))
    throw new TrainingError('INVALID_REQUEST', '请以文件上传方式提交文档。', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new TrainingError('INVALID_REQUEST', '上传内容为空。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > multipartLimit) {
        await reader.cancel();
        throw new TrainingError('MATERIAL_LIMIT_EXCEEDED', '当前单份文件上限为8 MiB。', 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }
  let form: FormData;
  try {
    form = await new Response(payload, {
      headers: { 'Content-Type': request.headers.get('content-type')! },
    }).formData();
  } catch {
    throw new TrainingError('INVALID_REQUEST', '上传内容无效，请重新选择文件。');
  }
  const file = form.get('file');
  if (!(file instanceof File) || form.getAll('file').length !== 1 || file.size === 0)
    throw new TrainingError('MATERIAL_EMPTY', '请选择一份非空的 Word 或 PDF 文档。');
  if (file.size > DOCUMENT_FILE_LIMIT)
    throw new TrainingError('MATERIAL_LIMIT_EXCEEDED', '当前单份文件上限为8 MiB。', 413);
  const format = file.name.split('.').pop()?.toLowerCase();
  if (format !== 'docx' && format !== 'pdf')
    throw new TrainingError(
      'MATERIAL_UNSUPPORTED',
      '请选择 DOCX 或 PDF；旧版 DOC 请先另存为 DOCX。',
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    (format === 'pdf' && new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') ||
    (format === 'docx' && !(bytes[0] === 0x50 && bytes[1] === 0x4b))
  )
    throw new TrainingError('MATERIAL_INVALID', '文件内容与扩展名不匹配，请检查原文件。');
  const result = await convert(bytes, format, request.signal);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (result.sourceHash !== hash)
    throw new TrainingError(
      'DOCUMENT_CONVERSION_FAILED',
      '转换结果与上传文件不匹配，请重新导入。',
      502,
    );
  return result;
}
