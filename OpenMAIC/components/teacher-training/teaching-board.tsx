'use client';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { SlideCanvas } from '@openmaic/renderer';
import type { Slide, PPTElement } from '@openmaic/dsl';
import katex from 'katex';
import { Pencil, MousePointer2, Undo2, Eraser, Type, Sigma } from 'lucide-react';
import type { BoardOperation } from '@/lib/teacher-training/classroom-contracts';
import styles from './classroom.module.css';

export function TeachingBoard({
  board,
  disabled,
  onOperation,
  onDirtyChange,
}: {
  board: Slide;
  disabled: boolean;
  onOperation: (operation: BoardOperation) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [pen, setPen] = useState(true);
  const [points, setPoints] = useState<[number, number][]>([]);
  const stroke = useRef<[number, number][]>([]);
  const active = useRef(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<BoardOperation>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    onDirtyChange(!!text.trim() || !!pending || points.length > 0);
  }, [text, pending, points.length, onDirtyChange]);
  const width = board.viewportSize;
  const height = width * board.viewportRatio;
  const save = async (operation: BoardOperation) => {
    if (saving || disabled) return;
    setSaving(true);
    setPending(operation);
    try {
      await onOperation(operation);
      setPending(undefined);
      setPoints([]);
      setText('');
    } catch {
      /* Parent displays the error; keep the unsaved operation for retry. */
    } finally {
      setSaving(false);
    }
  };
  function point(e: PointerEvent<SVGSVGElement>): [number, number] {
    const matrix = e.currentTarget.getScreenCTM();
    if (!matrix) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return [Math.max(0, Math.min(width, p.x)), Math.max(0, Math.min(height, p.y))];
  }
  const finish = () => {
    if (!active.current) return;
    active.current = false;
    if (disabled || stroke.current.length < 2) {
      setPoints([]);
      return;
    }
    const xs = stroke.current.map((p) => p[0]);
    const ys = stroke.current.map((p) => p[1]);
    const left = Math.min(...xs),
      top = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - left),
      h = Math.max(1, Math.max(...ys) - top);
    const element: PPTElement = {
      id: `ink_${crypto.randomUUID()}`,
      type: 'shape',
      left,
      top,
      width: w,
      height: h,
      rotate: 0,
      viewBox: [w, h],
      path: stroke.current
        .map(([x, y], i) => `${i ? 'L' : 'M'}${(x - left).toFixed(1)} ${(y - top).toFixed(1)}`)
        .join(' '),
      fixedRatio: false,
      fill: 'transparent',
      outline: { color: '#263e36', width: 2.5, style: 'solid' },
    };
    void save({ kind: 'add', element });
  };
  const insertText = (formula: boolean) => {
    if (!text.trim()) return;
    const base = {
      id: `board_${crypto.randomUUID()}`,
      left: 50,
      top: 45 + (board.elements.length % 6) * 80,
      width: 800,
      height: 70,
      rotate: 0,
    };
    const element: PPTElement = formula
      ? {
          ...base,
          type: 'latex',
          latex: text,
          html:
            '<span style="font-size:40px">' +
            katex.renderToString(text, { throwOnError: false, trust: false }) +
            '</span>',
          align: 'left',
          color: '#263e36',
        }
      : {
          ...base,
          type: 'text',
          defaultFontName: 'Noto Sans SC',
          defaultColor: '#263e36',
          content: `<p style="font-size:40px">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
        };
    void save({ kind: 'add', element });
  };
  return (
    <div className={styles.boardLayout}>
      <div className={styles.boardToolbar}>
        <button
          aria-label="手写笔"
          aria-pressed={pen}
          disabled={disabled || saving}
          onClick={() => setPen(true)}
        >
          <Pencil size={15} />
        </button>
        <button aria-label="查看白板" aria-pressed={!pen} onClick={() => setPen(false)}>
          <MousePointer2 size={15} />
        </button>
        <input
          aria-label="板书内容"
          value={text}
          disabled={disabled || saving}
          placeholder="输入文字或 LaTeX 公式"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') insertText(false);
          }}
        />
        <button disabled={disabled || saving || !text.trim()} onClick={() => insertText(false)}>
          <Type size={15} />
          文字
        </button>
        <button disabled={disabled || saving || !text.trim()} onClick={() => insertText(true)}>
          <Sigma size={15} />
          公式
        </button>
        <button
          aria-label="撤回最后一笔"
          disabled={disabled || saving || !board.elements.length}
          onClick={() => void save({ kind: 'remove', elementId: board.elements.at(-1)!.id })}
        >
          <Undo2 size={15} />
        </button>
        <button
          disabled={disabled || saving || !board.elements.length}
          onClick={() => {
            if (window.confirm('清空当前白板？已发生的板书记录仍会保留。'))
              void save({ kind: 'clear' });
          }}
        >
          <Eraser size={15} />
          清空
        </button>
        {pending && !saving && (
          <button disabled={disabled} onClick={() => void save(pending)}>
            重试保存板书
          </button>
        )}
      </div>
      <div className={styles.boardWrap} data-testid="teaching-whiteboard">
        <SlideCanvas
          slide={board}
          canvasPercentage={100}
          chrome={false}
          elementIdPrefix="training-board-"
        />
        <svg
          aria-label="手写画布"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            touchAction: 'none',
            pointerEvents: pen && !disabled && !saving && !pending ? 'auto' : 'none',
          }}
          viewBox={`0 0 ${width} ${height}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            active.current = true;
            stroke.current = [point(e)];
            setPoints(stroke.current);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!active.current || stroke.current.length >= 1200) return;
            stroke.current = [...stroke.current, point(e)];
            setPoints(stroke.current);
          }}
          onPointerUp={finish}
          onPointerCancel={() => {
            active.current = false;
            setPoints([]);
          }}
        >
          <polyline
            points={points.map((p) => p.join(',')).join(' ')}
            stroke="#263e36"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </div>
    </div>
  );
}
