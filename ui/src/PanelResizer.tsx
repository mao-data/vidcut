import { useRef, type PointerEvent, type RefObject } from 'react';
import { PANEL, resolvePanelDrag, type PanelSide } from './panelResize.js';
import { useView } from './stores/view.js';

/**
 * 面板寬度拖曳把手：掛在中欄左右緣的 6px 熱區（hover 亮紫線）。
 * 拖 <140px＝收合、拖回來＝展開；雙擊回預設寬。
 * 決策在 resolvePanelDrag（純函式），這裡只做指標事件與座標換算。
 */
export function PanelResizer({
  side,
  gridRef,
  onResizingChange,
}: {
  side: PanelSide;
  /** 三欄 grid 容器（座標換算基準） */
  gridRef: RefObject<HTMLDivElement | null>;
  /** 拖曳中要關掉 grid 的過渡動畫，結束再開 */
  onResizingChange: (resizing: boolean) => void;
}) {
  const dragging = useRef(false);

  const apply = (clientX: number) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawPx = side === 'left' ? clientX - rect.left : rect.right - clientX;
    const r = resolvePanelDrag(side, rawPx);
    const view = useView.getState();
    view.openPanel(side, r.open);
    if (r.open && r.width !== undefined) view.setPanelWidth(side, r.width);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    onResizingChange(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) apply(e.clientX);
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onResizingChange(false);
  };

  return (
    <div
      className="resizer"
      title="拖曳調整寬度；雙擊回預設"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        const view = useView.getState();
        view.openPanel(side, true);
        view.setPanelWidth(side, PANEL[side].default);
      }}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side === 'left' ? 'left' : 'right']: 0,
        width: 6,
        cursor: 'col-resize',
        zIndex: 10,
        touchAction: 'none',
      }}
    />
  );
}
