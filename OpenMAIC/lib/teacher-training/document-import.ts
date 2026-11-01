import type { MaterialContent } from './contracts';
import {
  DOCUMENT_FILE_LIMIT,
  DOCUMENT_SOURCE_LIMIT,
  DOCUMENT_TEXT_LIMIT,
  DRAFT_REQUEST_LIMIT,
  TEACHING_PROCESS_LIMIT,
  documentResultSchema,
  type DocumentPurpose,
  type DocumentResult,
} from './document-contracts';

export type ImportedDocument = {
  result: DocumentResult;
  source: MaterialContent['sources'][number];
};

export async function fileDataUrl(file: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('原文件读取失败，请重新选择文件。'));
    reader.onabort = () => reject(new DOMException('导入已取消', 'AbortError'));
    reader.onloadend = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) {
      reject(new DOMException('导入已取消', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(file);
  });
}

export async function readImportDocument(
  file: File,
  signal: AbortSignal,
): Promise<ImportedDocument> {
  const suffix = file.name.split('.').pop()?.toLowerCase();
  if (!suffix || !['txt', 'md', 'markdown', 'docx', 'pdf'].includes(suffix))
    throw new Error('请选择 DOCX、PDF、TXT 或 Markdown；旧版 DOC 请先另存为 DOCX。');
  if (!file.size) throw new Error('文件为空，请检查原文件。');
  const local = ['txt', 'md', 'markdown'].includes(suffix);
  if (file.size > (local ? 100_000 : DOCUMENT_FILE_LIMIT))
    throw new Error(local ? 'TXT／Markdown 单份上限为100 KB。' : 'Word／PDF 单份上限为8 MiB。');
  if (file.name.length > 200) throw new Error('文件名过长，请缩短文件名后重新导入。');
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sourceHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  let result: DocumentResult;
  if (local) {
    let markdown: string;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('文字文件不是 UTF-8 编码，请另存为 UTF-8 后导入。');
    }
    if (!markdown.trim()) throw new Error('没有可导入的文字，请检查原文件。');
    result = {
      text: markdown,
      markdown,
      warning: '',
      format: suffix === 'txt' ? 'txt' : 'md',
      sourceHash,
      conversion: {
        engine: 'local-text',
        version: '1',
        adapterVersion: 'openmaic-documents-v1',
        contentFormat: suffix === 'txt' ? 'text' : 'markdown',
        formulaHandling: 'not_processed',
        warnings: [],
        deferredFormulas: [],
      },
    };
  } else {
    const form = new FormData();
    form.set('file', file);
    const response = await fetch('/api/teacher-training/materials/extract', {
      method: 'POST',
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('文档转换没有返回有效结果，请稍后重试。');
    }
    if (!response.ok) throw new Error(body.message || '文档转换失败，请检查原文件。');
    result = documentResultSchema.parse(body.data);
    if (result.sourceHash !== sourceHash || result.format !== suffix)
      throw new Error('转换结果与原文件不一致，请重新导入。');
  }
  if (signal.aborted) throw new DOMException('导入已取消', 'AbortError');
  if (result.markdown.length > DOCUMENT_TEXT_LIMIT)
    throw new Error('转换结果超过10万字符，请拆分文档。');
  return {
    result,
    source: {
      name: file.name,
      format: result.format,
      originalText: result.markdown,
      originalData: await fileDataUrl(file, signal),
      sourceHash,
      conversion: result.conversion,
    },
  };
}

export function applyDocumentImport(
  current: MaterialContent,
  imported: ImportedDocument,
  edited: string,
  purpose: DocumentPurpose,
  mode: 'append' | 'replace' = 'append',
): MaterialContent {
  if (!edited.trim()) throw new Error('预览内容为空，请先核对要导入的文字。');
  if (edited.length > DOCUMENT_TEXT_LIMIT) throw new Error('编辑内容超过10万字符，请拆分导入。');
  const source: MaterialContent['sources'][number] = { ...imported.source, purpose };
  const matching = current.sources.findIndex(
    (s) =>
      s.purpose === purpose &&
      ((s.sourceHash && s.sourceHash === source.sourceHash) ||
        (!!s.originalData && s.originalData === source.originalData)),
  );
  if (matching < 0 && current.sources.length >= DOCUMENT_SOURCE_LIMIT)
    throw new Error('最多保留5份来源材料，请先处理已有材料。');
  let process = current.process;
  if (purpose === 'lesson_plan') {
    if (matching >= 0 && mode === 'append' && process.includes(edited.trim()))
      throw new Error(
        '这段内容已导入当前教学过程，未重复追加；如需整体替换，请选择“替换教学过程”。',
      );
    process = mode === 'replace' || !process.trim() ? edited : `${process}\n\n${edited}`;
    if (process.length > TEACHING_PROCESS_LIMIT)
      throw new Error(
        '应用后教学过程将超过30,000字符。请在预览中选取本次要导入的部分，原文件仍会完整保存。',
      );
  } else {
    // A reference may be edited before use. Keep the converter's original
    // Markdown separately in originalText; edited reference text is explicit.
    if (edited !== source.originalText) source.referenceText = edited;
  }
  const sources = [...current.sources];
  if (matching >= 0) sources[matching] = source;
  else sources.push(source);
  return validateDocumentDraft({ ...current, process, sources });
}

export function updateReferenceSource(
  current: MaterialContent,
  index: number,
  edited: string,
): MaterialContent {
  const source = current.sources[index];
  if (!source || source.purpose !== 'reference') throw new Error('此来源不支持修改参考正文。');
  if (!edited.trim()) throw new Error('参考内容为空，请保留要用于备课的正文。');
  if (edited.length > DOCUMENT_TEXT_LIMIT) throw new Error('参考正文超过10万字符，请拆分材料。');
  const updated = { ...source };
  if (edited === source.originalText) delete updated.referenceText;
  else updated.referenceText = edited;
  return validateDocumentDraft({
    ...current,
    sources: current.sources.map((entry, i) => (i === index ? updated : entry)),
  });
}

function validateDocumentDraft(next: MaterialContent): MaterialContent {
  const size = new Blob([
    JSON.stringify({ expectedRevision: Number.MAX_SAFE_INTEGER, content: next }),
  ]).size;
  if (size > DRAFT_REQUEST_LIMIT - 4096)
    throw new Error('原附件与草稿总量超过32 MiB保存上限，请拆分材料或移除较大的来源文件后重试。');
  return next;
}
