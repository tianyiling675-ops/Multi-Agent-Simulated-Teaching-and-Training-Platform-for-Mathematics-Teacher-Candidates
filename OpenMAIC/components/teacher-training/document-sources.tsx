'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { MaterialContent } from '@/lib/teacher-training/contracts';
import { updateReferenceSource } from '@/lib/teacher-training/document-import';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DocumentMarkdownPreview, MarkdownDownloadButton } from './document-markdown';
import styles from './document-sources.module.css';
import viewer from './document-importer.module.css';

type Source = MaterialContent['sources'][number];

export function DocumentSources({
  content,
  disabled,
  onChange,
  onBusyChange,
}: {
  content: MaterialContent;
  disabled: boolean;
  onChange: (content: MaterialContent) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [selected, setSelected] = useState<{ index: number; source: Source }>();
  const applyReference = (edited: string) => {
    if (!selected || content.sources[selected.index] !== selected.source)
      throw new Error('来源内容已有更新，请关闭后重新打开，保留已有草稿。');
    onChange(updateReferenceSource(content, selected.index, edited));
  };
  if (!content.sources.length) return null;
  return (
    <section className={styles.sources} aria-label="原始来源">
      <h3>
        原始来源 <span>{content.sources.length} / 5</span>
      </h3>
      {content.sources.map((source, index) => (
        <details key={`${index}-${source.name}`}>
          <summary>
            {source.name}
            <span>
              {source.purpose === 'lesson_plan'
                ? '教案'
                : source.purpose === 'courseware'
                  ? '课件'
                  : source.purpose === 'reference'
                    ? '参考材料'
                    : '来源材料'}
            </span>
          </summary>
          {source.conversion?.warnings.map((warning) => (
            <p key={warning.code}>{warning.message}</p>
          ))}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setSelected({ index, source })}
            >
              查看来源内容
            </button>
            {source.originalData && (
              <a href={source.originalData} download={source.name}>
                下载原文件
              </a>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                const formulaNote = source.conversion?.deferredFormulas.length
                  ? '此文件包含待处理公式，移除后当前草稿将失去对应原件。'
                  : '';
                if (
                  window.confirm(
                    `${formulaNote}从当前草稿移除“${source.name}”？教学文字、已导入课件页和历史材料版本仍会保留。`,
                  )
                )
                  onChange({ ...content, sources: content.sources.filter((_, i) => i !== index) });
              }}
            >
              从草稿移除来源
            </button>
          </div>
        </details>
      ))}
      {selected && (
        <SourceDocumentDialog
          source={selected.source}
          onClose={() => setSelected(undefined)}
          onApply={applyReference}
          onBusyChange={onBusyChange}
        />
      )}
    </section>
  );
}

function SourceDocumentDialog({
  source,
  onClose,
  onApply,
  onBusyChange,
}: {
  source: Source;
  onClose: () => void;
  onApply: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const reference = source.purpose === 'reference';
  const original = reference ? (source.referenceText ?? source.originalText) : source.originalText;
  const [edited, setEdited] = useState(original);
  const [error, setError] = useState('');
  const dirty = reference && edited !== original;
  useEffect(() => {
    onBusyChange(true);
    return () => onBusyChange(false);
  }, [onBusyChange]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  function close() {
    if (dirty && !window.confirm('参考正文有尚未应用的修改，确定放弃并关闭？')) return;
    onClose();
  }
  function apply() {
    try {
      onApply(edited);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请保留内容后重试。');
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className={viewer.dialog}
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <header className={viewer.header}>
          <div>
            <span className={viewer.eyebrow}>SAVED DOCUMENT</span>
            <DialogTitle className={viewer.title}>查看来源文档</DialogTitle>
            <DialogDescription className={viewer.description}>
              {source.name}
              <br />
              {reference
                ? '编辑核对后的参考正文，应用后用于后续备课；原文件和转换原文会保留。'
                : '这里展示归档的原始转换文字。当前教案请在“教学设计”中编辑。'}
            </DialogDescription>
          </div>
          <button aria-label="关闭来源文档" className={viewer.close} onClick={close}>
            <X size={19} />
          </button>
        </header>
        {source.conversion?.warnings.length ? (
          <div className={viewer.warnings} aria-label="文档核对提示">
            <div>
              {source.conversion.warnings.map((w) => (
                <p key={w.code}>{w.message}</p>
              ))}
            </div>
          </div>
        ) : null}
        {error && (
          <div className={viewer.error} role="alert">
            {error}
          </div>
        )}
        <div className={`${viewer.columns} ${reference ? '' : viewer.singleColumn}`}>
          {reference && (
            <section className={viewer.edit}>
              <div className={viewer.paneTitle}>
                <h3>参考正文</h3>
                <span>Markdown</span>
              </div>
              <textarea
                aria-label="参考正文"
                value={edited}
                spellCheck={false}
                onChange={(e) => {
                  setEdited(e.target.value);
                  setError('');
                }}
              />
            </section>
          )}
          <section className={viewer.read}>
            <div className={viewer.paneTitle}>
              <h3>{reference ? '阅读预览' : '转换原文'}</h3>
              <span>{reference ? '核对后应用' : '归档内容'}</span>
            </div>
            <DocumentMarkdownPreview text={edited} />
          </section>
        </div>
        <footer className={viewer.footer}>
          <p className={viewer.help}>
            {reference
              ? '应用后还需保存草稿；已确认的历史材料版本保留原内容。'
              : '下载 Markdown 导出这里的归档内容。'}
          </p>
          <div className={viewer.actions}>
            <MarkdownDownloadButton name={source.name} text={edited} />
            <button onClick={close}>关闭</button>
            {reference && (
              <button
                className={viewer.primary}
                disabled={!dirty || !edited.trim()}
                onClick={apply}
              >
                应用参考修改
              </button>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
