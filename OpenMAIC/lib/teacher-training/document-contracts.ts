import { z } from 'zod';

export const DOCUMENT_FILE_LIMIT = 8 * 1024 * 1024;
export const DOCUMENT_TEXT_LIMIT = 100_000;
export const TEACHING_PROCESS_LIMIT = 30_000;
export const DRAFT_REQUEST_LIMIT = 32 * 1024 * 1024;
export const DOCUMENT_SOURCE_LIMIT = 5;

export const documentWarningSchema = z
  .object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(1000),
  })
  .strict();

// A locator in the ORIGINAL archive, not a formula conversion result. A future
// formula adapter can reopen the archived bytes using this part and ordinal.
export const deferredFormulaSchema = z
  .object({
    id: z.string().regex(/^formula_[a-f0-9]{12}_\d+$/),
    part: z
      .string()
      .regex(/^word\/[a-zA-Z0-9_./-]+\.xml$/)
      .max(160),
    index: z.number().int().nonnegative().max(10_000),
    kind: z.enum(['office_math', 'embedded_object']),
  })
  .strict();

export const documentConversionSchema = z
  .object({
    engine: z.enum(['markitdown', 'local-text']),
    version: z.string().min(1).max(80),
    adapterVersion: z.literal('openmaic-documents-v1'),
    contentFormat: z.enum(['markdown', 'text']),
    formulaHandling: z.enum(['deferred', 'not_processed']),
    warnings: z.array(documentWarningSchema).max(64),
    deferredFormulas: z.array(deferredFormulaSchema).max(512),
    pages: z.number().int().positive().max(80).optional(),
  })
  .strict();

export const documentResultSchema = z
  .object({
    text: z.string().max(DOCUMENT_TEXT_LIMIT),
    markdown: z.string().max(DOCUMENT_TEXT_LIMIT),
    warning: z.string().max(20_000),
    format: z.enum(['docx', 'pdf', 'txt', 'md']),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    conversion: documentConversionSchema,
  })
  .strict();

export type DocumentConversion = z.infer<typeof documentConversionSchema>;
export type DocumentResult = z.infer<typeof documentResultSchema>;
export type DocumentPurpose = 'lesson_plan' | 'reference';
