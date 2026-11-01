'use client';

import { Download } from 'lucide-react';
import { Streamdown } from 'streamdown';
import styles from './document-importer.module.css';

const previewComponents = {
  img: ({ alt }: { alt?: string }) => (
    <span className={styles.asset}>【图片请对照原文件：{alt || '图片'}】</span>
  ),
  a: ({ children }: { children?: React.ReactNode }) => (
    <span className={styles.link}>{children}</span>
  ),
};

export function DocumentMarkdownPreview({ text }: { text: string }) {
  return (
    <div className={styles.preview} data-testid="document-markdown-preview">
      <Streamdown
        mode="static"
        parseIncompleteMarkdown={false}
        components={previewComponents}
        controls={false}
        plugins={{}}
      >
        {text}
      </Streamdown>
    </div>
  );
}

export function MarkdownDownloadButton({
  name,
  text,
  disabled = false,
}: {
  name: string;
  text: string;
  disabled?: boolean;
}) {
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'document'}.md`;
    anchor.click();
    // Let the browser acquire the blob before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <button type="button" disabled={disabled || !text.trim()} onClick={download}>
      <Download size={16} />
      下载 Markdown
    </button>
  );
}
