'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, Upload, Loader2, ArrowRight, AlertCircle, Check, X } from 'lucide-react';
import { DocumentMarkdownPreview, MarkdownDownloadButton } from './document-markdown';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import { readImportDocument, type ImportedDocument } from '@/lib/teacher-training/document-import';
import {
  TEACHING_PROCESS_LIMIT,
  type DocumentPurpose,
} from '@/lib/teacher-training/document-contracts';
import styles from './document-importer.module.css';

export function DocumentImporter({
  purpose,
  disabled,
  processLength = 0,
  onApply,
  onBusyChange,
}: {
  purpose: DocumentPurpose;
  disabled: boolean;
  processLength?: number;
  onApply: (document: ImportedDocument, edited: string, mode: 'append' | 'replace') => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [document, setDocument] = useState<ImportedDocument>();
  const [edited, setEdited] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const controller = useRef<AbortController | null>(null);
  const lifecycle = useRef(onBusyChange);
  useEffect(() => {
    lifecycle.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(
    () => () => {
      controller.current?.abort();
      lifecycle.current(false);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [open]);

  const lessonPlan = purpose === 'lesson_plan';
  const title = lessonPlan ? '导入教案' : '导入参考文档';
  const resultingLength =
    mode === 'replace' || !processLength ? edited.length : processLength + 2 + edited.length;
  const tooLong = lessonPlan && resultingLength > TEACHING_PROCESS_LIMIT;

  function changeOpen(next: boolean, applied = false) {
    if (
      !next &&
      !applied &&
      document &&
      edited !== document.result.markdown &&
      !window.confirm('预览中有尚未应用的修改，确定放弃并关闭？当前教案保持不变。')
    )
      return;
    controller.current?.abort();
    controller.current = null;
    setOpen(next);
    setWorking(false);
    onBusyChange(next);
    if (!next) {
      setDocument(undefined);
      setEdited('');
      setError('');
      setMode('append');
    }
  }

  async function select(file: File) {
    if (
      document &&
      edited !== document.result.markdown &&
      !window.confirm('当前预览有修改，确定选择另一份文件？')
    )
      return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setWorking(true);
    setDocument(undefined);
    setEdited('');
    setError('');
    try {
      const result = await readImportDocument(file, request.signal);
      if (request.signal.aborted || controller.current !== request) return;
      setDocument(result);
      setEdited(result.result.markdown);
    } catch (cause) {
      if (!request.signal.aborted && controller.current === request)
        setError(cause instanceof Error ? cause.message : '导入失败，请重试。');
    } finally {
      if (controller.current === request) setWorking(false);
    }
  }

  function apply() {
    if (!document || working || tooLong) return;
    try {
      onApply(document, edited, mode);
      changeOpen(false, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '未能应用，请保留预览后重试。');
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <button type="button" className={styles.trigger} disabled={disabled}>
          <FileText size={17} />
          {title}
        </button>
      </DialogTrigger>
      <DialogContent
        className={styles.dialog}
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>DOCUMENT IMPORT</span>
            <DialogTitle className={styles.title}>{title}</DialogTitle>
            <DialogDescription className={styles.description}>
              {lessonPlan
                ? '先核对文档，再应用到教学过程。'
                : '核对后作为备课参考，不改动教学过程。'}
              原文件会随保存的材料保留。
            </DialogDescription>
          </div>
          <button
            aria-label="关闭文档导入"
            className={styles.close}
            onClick={() => changeOpen(false)}
          >
            <X size={19} />
          </button>
        </header>
        <div className={styles.filebar}>
          <label className={styles.choose}>
            <Upload size={16} />
            {document ? '更换文档' : '选择文档'}
            <input
              aria-label={lessonPlan ? '教案文件' : '参考文档文件'}
              type="file"
              accept=".docx,.pdf,.txt,.md,.markdown,.doc"
              disabled={working}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void select(file);
              }}
            />
          </label>
          <div className={styles.filename}>
            {document ? (
              <>
                <strong>{document.source.name}</strong>
                <span>
                  {document.result.conversion.engine === 'markitdown' ? '文档已转换' : '文字已读取'}{' '}
                  · {document.result.markdown.length.toLocaleString()} 字符 · 尚未应用
                </span>
              </>
            ) : (
              <span>Word（DOCX）／PDF ≤8 MiB · TXT／Markdown ≤100 KB</span>
            )}
          </div>
          {working && (
            <span className={styles.progress} role="status">
              <Loader2 size={16} className={styles.spin} />
              正在转换文档…
            </span>
          )}
        </div>
        {error && (
          <div className={styles.error} role="alert">
            <AlertCircle size={17} />
            <p>{error}</p>
          </div>
        )}
        {document?.result.conversion.warnings.length ? (
          <div className={styles.warnings} aria-label="文档核对提示">
            <AlertCircle size={17} />
            <div>
              {document.result.conversion.warnings.map((item) => (
                <p key={item.code}>{item.message}</p>
              ))}
            </div>
          </div>
        ) : null}
        {document ? (
          <div className={styles.columns}>
            <section className={styles.edit}>
              <div className={styles.paneTitle}>
                <h3>编辑导入内容</h3>
                <span>Markdown</span>
              </div>
              <textarea
                aria-label="导入内容"
                value={edited}
                disabled={working}
                spellCheck={false}
                onChange={(event) => {
                  setEdited(event.target.value);
                  setError('');
                }}
              />
            </section>
            <section className={styles.read}>
              <div className={styles.paneTitle}>
                <h3>阅读预览</h3>
                <span>核对标题、表格与正文</span>
              </div>
              <DocumentMarkdownPreview text={edited} />
            </section>
          </div>
        ) : (
          <div className={styles.empty}>
            <div className={styles.paper}>
              <FileText size={38} />
            </div>
            <h3>把已有教案带进来</h3>
            <p>
              保留正文、标题、列表和可转换的表格。
              <br />
              Word 公式先保留位置，扫描 PDF 需要另行识别。
            </p>
            <span>转换和预览阶段不会更改你的草稿</span>
          </div>
        )}
        <footer className={styles.footer}>
          <div>
            {lessonPlan && document && (
              <div className={styles.modes} role="radiogroup" aria-label="教案应用方式">
                <label>
                  <input
                    type="radio"
                    name="document-mode"
                    checked={mode === 'append'}
                    onChange={() => {
                      setMode('append');
                      setError('');
                    }}
                  />
                  追加到教学过程
                </label>
                <label>
                  <input
                    type="radio"
                    name="document-mode"
                    checked={mode === 'replace'}
                    onChange={() => {
                      setMode('replace');
                      setError('');
                    }}
                  />
                  替换教学过程
                </label>
              </div>
            )}
            <p className={tooLong ? styles.overLimit : styles.help}>
              {document
                ? lessonPlan
                  ? `应用后 ${resultingLength.toLocaleString()} / 30,000 字符${tooLong ? '，请编辑或选取本次要导入的部分' : '；其余教学栏目保留已有内容'}`
                  : '作为参考来源保存，供后续备课使用'
                : '旧版 DOC 请先另存为 DOCX。'}
            </p>
          </div>
          <div className={styles.actions}>
            {document && (
              <MarkdownDownloadButton
                name={document.source.name}
                text={edited}
                disabled={working}
              />
            )}
            <button onClick={() => changeOpen(false)}>{working ? '取消转换' : '取消'}</button>
            <button
              className={styles.primary}
              disabled={!document || working || !edited.trim() || tooLong}
              onClick={apply}
            >
              <Check size={16} />
              {lessonPlan ? '应用到草稿' : '加入参考材料'}
              <ArrowRight size={16} />
            </button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
