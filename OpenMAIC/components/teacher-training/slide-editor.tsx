'use client';
import { useRef, useState } from 'react';
import { EditableSlideCanvasWithUI } from '@openmaic/editor/ui';
import { EMPTY_SELECTION, type Selection } from '@openmaic/editor/react';
import {
  applyEditorTransaction,
  createEditorHistory,
  undoEditorTransaction,
  redoEditorTransaction,
  type EditorTransaction,
} from '@openmaic/editor/core';
import type { Slide } from '@openmaic/dsl';
export function TrainingSlideEditor({
  slide,
  onChange,
}: {
  slide: Slide;
  onChange: (slide: Slide) => void;
}) {
  const [history, setHistory] = useState(() =>
    createEditorHistory({ type: 'slide', canvas: slide }),
  );
  const current = useRef(history);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const apply = (transaction: EditorTransaction) => {
    const next = applyEditorTransaction(current.current, transaction);
    current.current = next;
    setHistory(next);
    onChange(next.present.canvas);
  };
  const travel = (undo: boolean) => {
    const next = (undo ? undoEditorTransaction : redoEditorTransaction)(current.current);
    current.current = next;
    setHistory(next);
    onChange(next.present.canvas);
  };
  return (
    <div
      data-testid="training-slide-editor"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      <div style={{ display: 'flex', gap: 8, padding: '8px 12px', fontSize: 12 }}>
        <button type="button" onClick={() => travel(true)}>
          撤销
        </button>
        <button type="button" onClick={() => travel(false)}>
          重做
        </button>
        <span style={{ marginLeft: 'auto', color: '#6c7b72' }}>
          双击文字编辑 · 拖动调整 · 修改保存在草稿
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <EditableSlideCanvasWithUI
          slide={history.present.canvas}
          selection={selection}
          onSelectionChange={setSelection}
          onTransaction={apply}
          host={{ locale: 'zh-CN' }}
          insertItems={['text', 'image', 'line', 'table', 'chart', 'latex', 'background']}
          snapping
        />
      </div>
    </div>
  );
}
