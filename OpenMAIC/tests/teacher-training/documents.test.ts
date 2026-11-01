import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { emptyMaterial, materialSchema } from '@/lib/teacher-training/contracts';
import {
  applyDocumentImport,
  updateReferenceSource,
  type ImportedDocument,
} from '@/lib/teacher-training/document-import';
import {
  convertDocument,
  documentConverterCapability,
} from '@/lib/teacher-training/document-converter';
import { extractTrainingFile } from '@/lib/teacher-training/extract';
import { cleanMaterial } from '@/lib/teacher-training/materials';
import type { DocumentResult } from '@/lib/teacher-training/document-contracts';

const bytes = new TextEncoder().encode('%PDF-1.4 fixture bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const result = (format: 'docx' | 'pdf' = 'pdf'): DocumentResult => ({
  text: '# 教学设计\n\n| 环节 | 活动 |\n| --- | --- |\n| 导入 | 提问 |',
  markdown: '# 教学设计\n\n| 环节 | 活动 |\n| --- | --- |\n| 导入 | 提问 |',
  warning: '请核对原文件',
  format,
  sourceHash: hash,
  conversion: {
    engine: 'markitdown',
    version: '0.1.9',
    adapterVersion: 'openmaic-documents-v1',
    contentFormat: 'markdown',
    formulaHandling: 'not_processed',
    warnings: [{ code: 'REVIEW', message: '请核对原文件' }],
    deferredFormulas: [],
  },
});
const imported = (): ImportedDocument => ({
  result: result(),
  source: {
    name: '教案.pdf',
    format: 'pdf',
    originalText: result().markdown,
    sourceHash: hash,
    originalData: 'data:application/pdf;base64,' + Buffer.from(bytes).toString('base64'),
    conversion: result().conversion,
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('document preview -> draft', () => {
  it('re-edits a saved reference while preserving source bytes, provenance and the lesson plan', () => {
    const current = applyDocumentImport(
      { ...emptyMaterial(), process: '教师已确认的教案' },
      imported(),
      '第一次核对',
      'reference',
    );
    const revised = updateReferenceSource(current, 0, '第二次核对');
    expect(revised.process).toBe(current.process);
    expect(revised.sources[0]).toEqual({ ...current.sources[0], referenceText: '第二次核对' });
    expect(current.sources[0].referenceText).toBe('第一次核对');
    expect(cleanMaterial(revised).sources[0].sourceHash).toBe(hash);
    const restored = updateReferenceSource(revised, 0, result().markdown);
    expect(restored.sources[0].referenceText).toBeUndefined();
    expect(restored.sources[0].originalText).toBe(result().markdown);
  });
  it('rejects invalid reference edits without changing the saved source', () => {
    const current = applyDocumentImport(emptyMaterial(), imported(), '参考正文', 'reference');
    expect(() => updateReferenceSource(current, 0, ' ')).toThrow('为空');
    expect(() => updateReferenceSource(current, 0, '字'.repeat(100_001))).toThrow('10万');
    expect(() => updateReferenceSource(current, 99, '正文')).toThrow('不支持');
    const lesson = applyDocumentImport(emptyMaterial(), imported(), '教案', 'lesson_plan');
    expect(() => updateReferenceSource(lesson, 0, '替换')).toThrow('不支持');
    expect(current.sources[0].referenceText).toBe('参考正文');
  });
  it('appends only after application, retaining the original file, conversion metadata and other fields', () => {
    const current = {
      ...emptyMaterial(),
      objectives: '已有目标',
      process: '已有讲解',
      notes: '私有备注',
    };
    const before = structuredClone(current);
    const next = applyDocumentImport(current, imported(), '核对后的教案', 'lesson_plan');
    expect(current).toEqual(before);
    expect(next.process).toBe('已有讲解\n\n核对后的教案');
    expect(next.objectives).toBe('已有目标');
    expect(next.notes).toBe('私有备注');
    expect(next.sources[0].originalText).toBe(result().markdown);
    expect(next.sources[0].originalData).toBe(imported().source.originalData);
    expect(next.sources[0].purpose).toBe('lesson_plan');
    expect(materialSchema.parse(next)).toEqual(next);
    expect(cleanMaterial(next)).toEqual(next);
  });
  it('requires explicit replace, and does not duplicate an identical append', () => {
    const first = applyDocumentImport(
      { ...emptyMaterial(), process: '旧内容' },
      imported(),
      '新内容',
      'lesson_plan',
    );
    expect(() => applyDocumentImport(first, imported(), '新内容', 'lesson_plan')).toThrow(
      '未重复追加',
    );
    const replaced = applyDocumentImport(first, imported(), '替换后', 'lesson_plan', 'replace');
    expect(replaced.process).toBe('替换后');
    expect(replaced.sources).toHaveLength(1);
    const chunk = applyDocumentImport(first, imported(), '同文件的另一段', 'lesson_plan');
    expect(chunk.sources).toHaveLength(1);
    expect(chunk.process).toContain('同文件的另一段');
  });
  it('keeps references separate from the teaching process and preserves pre-edit conversion text', () => {
    const current = { ...emptyMaterial(), process: '已有讲解' };
    const next = applyDocumentImport(current, imported(), '编辑后的参考', 'reference');
    expect(next.process).toBe('已有讲解');
    expect(next.sources[0].originalText).toBe(result().markdown);
    expect(next.sources[0].referenceText).toBe('编辑后的参考');
    expect(
      applyDocumentImport(next, imported(), '参考第二次编辑', 'reference').sources,
    ).toHaveLength(1);
  });
  it('rejects excessive teaching text, source count and empty application without truncation or mutation', () => {
    const current = { ...emptyMaterial(), process: '原有内容' };
    expect(() =>
      applyDocumentImport(current, imported(), '字'.repeat(30_000), 'lesson_plan'),
    ).toThrow('30,000');
    expect(current.process).toBe('原有内容');
    expect(current.sources).toHaveLength(0);
    expect(() => applyDocumentImport(current, imported(), ' ', 'lesson_plan')).toThrow('为空');
    const full = {
      ...current,
      sources: Array.from({ length: 5 }, (_, i) => ({
        name: '来源' + i,
        format: 'txt' as const,
        originalText: '内容',
      })),
    };
    expect(() => applyDocumentImport(full, imported(), '新内容', 'reference')).toThrow('5份');
  });
  it('rejects mismatched source bytes and preserves formula locations without converting them', () => {
    const data = imported();
    const metadata = {
      ...data.source.conversion!,
      formulaHandling: 'deferred' as const,
      deferredFormulas: [
        {
          id: 'formula_123456abcdef_1',
          part: 'word/document.xml',
          index: 0,
          kind: 'office_math' as const,
        },
      ],
    };
    const next = applyDocumentImport(
      emptyMaterial(),
      { ...data, source: { ...data.source, conversion: metadata } },
      '【公式待处理：formula_123456abcdef_1】',
      'lesson_plan',
    );
    expect(cleanMaterial(next).sources[0].conversion?.deferredFormulas).toEqual(
      metadata.deferredFormulas,
    );
    expect(() =>
      cleanMaterial({ ...next, sources: [{ ...next.sources[0], sourceHash: '0'.repeat(64) }] }),
    ).toThrow('原文件校验失败');
    expect(() =>
      cleanMaterial({ ...next, sources: [{ ...next.sources[0], originalData: undefined }] }),
    ).toThrow('保留原文件');
  });
  it('rejects a draft whose combined original attachments exceed the save limit', () => {
    const current = {
      ...emptyMaterial(),
      sources: Array.from({ length: 3 }, (_, index) => ({
        name: `existing-${index}.pdf`,
        format: 'pdf' as const,
        originalText: '参考',
        originalData: 'data:application/pdf;base64,' + 'A'.repeat(11_200_000),
      })),
    };
    expect(() => applyDocumentImport(current, imported(), '新参考', 'reference')).toThrow('32 MiB');
    expect(current.sources).toHaveLength(3);
  });
});

describe('document extraction and service transport', () => {
  it('sends uploaded bytes to the fixed converter endpoint and validates response shape', async () => {
    vi.stubEnv('DOCUMENT_CONVERTER_URL', 'http://127.0.0.1:9040');
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(result()),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await convertDocument(bytes, 'pdf', new AbortController().signal)).toEqual(result());
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9040/convert/pdf');
  });
  it('retains OCR and damaged-file errors instead of classifying them as storage errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ code: 'OCR_REQUIRED', message: '需要OCR' }, { status: 400 }),
      ),
    );
    await expect(convertDocument(bytes, 'pdf', new AbortController().signal)).rejects.toMatchObject(
      { code: 'OCR_REQUIRED', message: '需要OCR' },
    );
  });
  it('distinguishes an unavailable service and never returns its private error detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('private internal host credential');
      }),
    );
    await expect(convertDocument(bytes, 'pdf', new AbortController().signal)).rejects.toMatchObject(
      { code: 'DOCUMENT_SERVICE_UNAVAILABLE' },
    );
    expect(await documentConverterCapability()).toEqual({
      enabled: false,
      formulaHandling: 'deferred',
    });
  });
  it('rejects incomplete converter output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...result(), conversion: {} })),
    );
    await expect(convertDocument(bytes, 'pdf', new AbortController().signal)).rejects.toMatchObject(
      { code: 'DOCUMENT_CONVERSION_FAILED' },
    );
  });
  it('does not guess a production converter URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DOCUMENT_CONVERTER_URL', '');
    await expect(convertDocument(bytes, 'pdf', new AbortController().signal)).rejects.toMatchObject(
      { code: 'DOCUMENT_SERVICE_UNAVAILABLE' },
    );
  });
  it('checks format signatures before requesting conversion and verifies the returned source hash', async () => {
    const form = new FormData();
    form.set('file', new File(['not pdf'], 'wrong.pdf'));
    const convert = vi.fn();
    await expect(
      extractTrainingFile(
        new Request('http://localhost/extract', { method: 'POST', body: form }),
        convert,
      ),
    ).rejects.toMatchObject({ code: 'MATERIAL_INVALID' });
    expect(convert).not.toHaveBeenCalled();
    const good = new FormData();
    good.set('file', new File([new Uint8Array(bytes).buffer], 'valid.pdf'));
    await expect(
      extractTrainingFile(
        new Request('http://localhost/extract', { method: 'POST', body: good }),
        async () => ({ ...result(), sourceHash: '0'.repeat(64) }),
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_FAILED' });
  });
});
