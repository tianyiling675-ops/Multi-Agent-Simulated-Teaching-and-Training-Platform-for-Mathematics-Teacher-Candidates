import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import JSZip from 'jszip';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...values: string[]): unknown;
      get(): { body: unknown } | undefined;
      all(): unknown[];
    };
    close(): void;
  };
};
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, emptyMaterial } from '@/lib/teacher-training/contracts';
import { SqliteTrainingStore } from '@/lib/teacher-training/sqlite-store';
import {
  PgTrainingStore,
  ensureTrainingSchema,
  type TrainingQueryable,
} from '@/lib/teacher-training/pg-store';
import { extractTrainingFile } from '@/lib/teacher-training/extract';
const asset = 'data:image/png;base64,' + 'A'.repeat(2048);
const initial = () => {
  const s = emptyState();
  s.projects.p = {
    id: 'p',
    title: '历史课题',
    grade: '高中',
    scope: '函数',
    createdAt: '2026-10-25',
    updatedAt: '2026-10-25',
  };
  s.drafts.p = {
    id: 'p',
    projectId: 'p',
    revision: 1,
    content: {
      ...emptyMaterial(),
      process: '原内容',
      sources: [{ name: 'a.pptx', format: 'pptx', originalText: '原来源', originalData: asset }],
    },
  };
  return s;
};
describe('record storage migration and document import', () => {
  it('migrates an old SQLite owner without rewriting unchanged material/assets on later writes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'training-records-')), 'test.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE teacher_training_owners(owner_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
    db.prepare('INSERT INTO teacher_training_owners VALUES (?,?)').run(
      'owner',
      JSON.stringify(initial()),
    );
    const store = new SqliteTrainingStore(path);
    try {
      expect(await store.read('owner')).toEqual(initial());
      await store.update('owner', (s) => {
        s.projects.p.title = '新标题';
      });
      expect((await store.read('owner')).drafts.p.content.sources[0].originalData).toBe(asset);
      const old = db.prepare("SELECT body FROM teacher_training_records WHERE kind='drafts'").get()!
        .body;
      db.exec(
        'CREATE TABLE write_log(kind TEXT); CREATE TRIGGER track_write AFTER UPDATE ON teacher_training_records BEGIN INSERT INTO write_log VALUES (NEW.kind); END;',
      );
      await store.update('owner', (s) => {
        s.projects.p.title = '又一标题';
      });
      expect(db.prepare('SELECT kind FROM write_log').all()).toEqual([{ kind: 'projects' }]);
      expect(
        db.prepare("SELECT body FROM teacher_training_records WHERE kind='drafts'").get()!.body,
      ).toBe(old);
      expect((await store.read('other')).projects).toEqual({});
    } finally {
      store.close();
      db.close();
    }
  });
  it('migrates a PostgreSQL aggregate and restores asset bytes', async () => {
    const pg = new PGlite();
    await ensureTrainingSchema(pg as TrainingQueryable);
    await pg.query('INSERT INTO teacher_training_owners VALUES ($1,$2::jsonb)', [
      'owner',
      JSON.stringify(initial()),
    ]);
    const store = new PgTrainingStore(pg as TrainingQueryable, (work) =>
      pg.transaction((tx) => work(tx as TrainingQueryable)),
    );
    try {
      await store.update('owner', (s) => {
        s.projects.p.title = '新标题';
      });
      expect((await store.read('owner')).drafts.p.content.sources[0].originalData).toBe(asset);
      expect(
        (await pg.query("SELECT kind FROM teacher_training_records WHERE kind='assets'")).rows,
      ).toHaveLength(1);
    } finally {
      await pg.close();
    }
  });
  it('validates a DOCX upload, passes its bytes to the converter and verifies its hash', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>椭圆</w:t></w:r><w:r><w:t>的定义</w:t></w:r></w:p><w:p><w:r><w:t>解释焦点</w:t></w:r></w:p></w:body></w:document>',
    );
    zip.file('docProps/core.xml', 'PRIVATE_METADATA');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const form = new FormData();
    form.set('file', new File([new Uint8Array(bytes).buffer], 'test.docx'));
    const result = await extractTrainingFile(
      new Request('http://localhost/extract', { method: 'POST', body: form }),
      async (received, format, signal) => {
        expect(received).toEqual(bytes);
        expect(format).toBe('docx');
        expect(signal.aborted).toBe(false);
        return {
          text: '椭圆的定义\n解释焦点',
          markdown: '椭圆的定义\n解释焦点',
          warning: '公式未转换',
          format,
          sourceHash: createHash('sha256').update(received).digest('hex'),
          conversion: {
            engine: 'markitdown',
            version: '0.1.9',
            adapterVersion: 'openmaic-documents-v1',
            contentFormat: 'markdown',
            formulaHandling: 'not_processed',
            warnings: [],
            deferredFormulas: [],
          },
        };
      },
    );
    expect(result.text).toBe('椭圆的定义\n解释焦点');
    expect(result.warning).toContain('未转换');
  });
});
