import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import type { Slide } from '@openmaic/dsl';
import { TrainingError, type MaterialContent } from './contracts';
import { slideSchema } from './classroom-contracts';
import { createHash } from 'node:crypto';

// Snapshot resources are embedded bytes. Mutable URLs and temporary blob URLs
// must be resolved by the preparation uploader before a version is confirmed.
export function validateSnapshot(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(validateSnapshot);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      ['src', 'poster', 'url'].includes(key) &&
      typeof entry === 'string' &&
      entry &&
      !/^data:(image\/(png|jpeg|webp|gif|svg\+xml)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]+$/i.test(
        entry,
      )
    ) {
      throw new TrainingError(
        'ASSET_NOT_FROZEN',
        '页面包含未归档的资源，请重新导入，或移除该资源后确认。',
      );
    }
    if (key === 'mediaRef' && entry)
      throw new TrainingError('ASSET_NOT_FROZEN', '页面仍引用可变媒体任务，请先归档资源。');
    if (key === 'link' && entry)
      throw new TrainingError('MATERIAL_UNSUPPORTED', '训练快照暂不支持页面外链，请移除链接。');
    validateSnapshot(entry);
  }
}
export function cleanSlide(slide: Slide): Slide {
  if (!slideSchema.safeParse(slide).success)
    throw new TrainingError('MATERIAL_INVALID', '页面结构不完整，请核对页面元素。');
  validateSnapshot(slide);
  const ids = new Set<string>();
  for (const element of slide.elements) {
    if (ids.has(element.id)) throw new TrainingError('MATERIAL_INVALID', '页面元素标识重复。');
    ids.add(element.id);
    if (
      ![
        'text',
        'image',
        'shape',
        'line',
        'chart',
        'table',
        'latex',
        'code',
        'video',
        'audio',
      ].includes(element.type)
    )
      throw new TrainingError('MATERIAL_UNSUPPORTED', '页面包含不支持的元素，请在预览中核对。');
  }
  return sanitizeSceneContent(slide);
}
export function cleanMaterial(content: MaterialContent): MaterialContent {
  for (const source of content.sources) {
    if (source.sourceHash && source.originalData) {
      const bytes = Buffer.from(source.originalData.split(',')[1] ?? '', 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== source.sourceHash)
        throw new TrainingError('SOURCE_HASH_MISMATCH', '原文件校验失败，请重新导入该文档。');
    }
    if (source.conversion?.deferredFormulas.length && !source.originalData)
      throw new TrainingError('SOURCE_MISSING', '待处理公式需要保留原文件，请重新导入文档。');
  }
  if (!content.pages) return content;
  const ids = new Set<string>();
  return {
    ...content,
    pages: content.pages.map((page) => {
      if (ids.has(page.id)) throw new TrainingError('MATERIAL_INVALID', '页面标识重复。');
      ids.add(page.id);
      return { ...page, canvas: cleanSlide(page.canvas) };
    }),
  };
}
