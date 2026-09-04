// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 02 · A, and ask 01 · property 2 ("creatable over the user's
//  current selection").
//
//  Catching the gesture at all. The listeners below are CAPTURE-phase and PASSIVE, on the
//  container, because:
//
//   · capture — the SDK's own handlers sit on elements inside its shadow root and the events
//     do not usefully reach us on the way back up;
//   · passive, and nothing calls preventDefault — the SDK must keep painting its own
//     selection highlight underneath, and propagation is left alone so it still receives the
//     gesture;
//   · the coordinates have to be converted twice, first out of the SDK's CSS scale (read by
//     comparing a page's rendered box to its natural box, because zoom is not readable) and
//     then into page-local pt for the geometry walkers.
//
//  `placeholders.add({ key, fromSelection: true })` would delete this file.
// ─────────────────────────────────────────────────────────────────────────────────────────
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import type { DocAuthEditor } from "@nutrient-sdk/document-authoring";

import {
  type BlueprintTextSelection,
  type PageLocalPoint,
  deriveTextSelection,
  deriveWordSelection,
} from "@/internal/selectionGeometry";
import { findPageDivs, getDocumentContext, pageBoxWidthPx } from "@/internal/snapshotLayout";
import { trace } from "@/internal/trace";

export type { BlueprintTextSelection };

/** Below this much movement the gesture was a click placing a caret, not a drag selection. */
export const SELECTION_DRAG_SLOP_PX = 6;

type PageHit = { pageIndex: number; pageDiv: HTMLElement };

function pageDivAt(container: HTMLElement, clientX: number, clientY: number): PageHit | null {
  const pageDivs = findPageDivs(container);
  for (let pageIndex = 0; pageIndex < pageDivs.length; pageIndex++) {
    const rect = pageDivs[pageIndex].getBoundingClientRect();
    const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    if (inside) return { pageIndex, pageDiv: pageDivs[pageIndex] };
  }
  return null;
}

/**
 * The rendered/natural ratio of a page div — the SDK's CSS zoom scale, which it exposes no
 * other way. Case ask 02 · D.
 */
function pageScale(pageDiv: HTMLElement): { x: number; y: number } {
  const rendered = pageDiv.getBoundingClientRect();
  return {
    x: pageDiv.offsetWidth > 0 ? rendered.width / pageDiv.offsetWidth : 1,
    y: pageDiv.offsetHeight > 0 ? rendered.height / pageDiv.offsetHeight : 1,
  };
}

/**
 * A client point in the page div's natural coordinates, clamped into the page. Clamping is
 * what makes a drag that runs off the page still select to the end of the line it left, which
 * is how every other text surface behaves.
 */
function toPageLocalClamped(pageDiv: HTMLElement, clientX: number, clientY: number): PageLocalPoint {
  const rendered = pageDiv.getBoundingClientRect();
  const scale = pageScale(pageDiv);
  const x = scale.x > 0 ? (clientX - rendered.left) / scale.x : 0;
  const y = scale.y > 0 ? (clientY - rendered.top) / scale.y : 0;
  return {
    x: Math.min(Math.max(x, 0), pageDiv.offsetWidth),
    y: Math.min(Math.max(y, 0), pageDiv.offsetHeight),
  };
}

/** Where to hang the mint card, in client px. */
export type SelectionAnchor = { clientLeft: number; clientTop: number };

export type UseTextSelectionParams = {
  containerRef: RefObject<HTMLElement | null>;
  editorRef: RefObject<DocAuthEditor | null>;
  /** Off → no listeners attached, and any live selection is dropped. */
  enabled: boolean;
};

export type TextSelectionResult = {
  selection: BlueprintTextSelection | null;
  anchor: SelectionAnchor | null;
  clear: () => void;
};

/**
 * A drag or double-click over the canvas, turned into a derived text selection.
 *
 * Everything the SDK already knows and will not report: which block the gesture is in, where
 * each end of it falls between two glyphs, and what text lies between them.
 */
export function useTextSelection({
  containerRef,
  editorRef,
  enabled,
}: UseTextSelectionParams): TextSelectionResult {
  const [selection, setSelection] = useState<BlueprintTextSelection | null>(null);
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const downRef = useRef<{ clientX: number; clientY: number; hit: PageHit } | null>(null);

  const clear = useCallback(() => {
    setSelection(null);
    setAnchor(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      clear();
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    /** The anchor sits under the last rect of the selection, in client px. */
    const anchorFor = (hit: PageHit, derived: BlueprintTextSelection): SelectionAnchor => {
      const rendered = hit.pageDiv.getBoundingClientRect();
      const scale = pageScale(hit.pageDiv);
      const last = derived.rects[derived.rects.length - 1];
      return {
        clientLeft: rendered.left + (last.left + last.width / 2) * scale.x,
        clientTop: rendered.top + (last.top + last.height) * scale.y + 8,
      };
    };

    const resolve = (
      hit: PageHit,
      from: PageLocalPoint,
      to: PageLocalPoint | null,
    ): BlueprintTextSelection | null => {
      const editor = editorRef.current;
      if (!editor) return null;
      const documentContext = getDocumentContext(editor);
      if (!documentContext) return null;
      const pageDivWidthPx = pageBoxWidthPx(hit.pageDiv);
      const shared = { documentContext, pageIndex: hit.pageIndex, pageDivWidthPx };
      return to === null
        ? deriveWordSelection({ ...shared, at: from })
        : deriveTextSelection({ ...shared, from, to });
    };

    const onPointerDown = (event: PointerEvent) => {
      const hit = pageDivAt(container, event.clientX, event.clientY);
      downRef.current = hit ? { clientX: event.clientX, clientY: event.clientY, hit } : null;
    };

    const onPointerUp = (event: PointerEvent) => {
      const down = downRef.current;
      downRef.current = null;
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY);
      if (moved < SELECTION_DRAG_SLOP_PX) {
        clear();
        return;
      }
      trace({
        capability: "select",
        reach: "dom-shape",
        touched: "capture-phase, passive pointerdown/pointerup on the container + getBoundingClientRect / offsetWidth scale",
        because:
          "There is no selection event and no selection geometry. The raw gesture is intercepted before the SDK's own handlers and its coordinates un-zoomed by comparing a page's rendered box to its natural one.",
        ask: "02 · A",
      });
      const derived = resolve(
        down.hit,
        toPageLocalClamped(down.hit.pageDiv, down.clientX, down.clientY),
        toPageLocalClamped(down.hit.pageDiv, event.clientX, event.clientY),
      );
      setSelection(derived);
      setAnchor(derived ? anchorFor(down.hit, derived) : null);
    };

    const onDoubleClick = (event: MouseEvent) => {
      const hit = pageDivAt(container, event.clientX, event.clientY);
      if (!hit) return;
      const derived = resolve(hit, toPageLocalClamped(hit.pageDiv, event.clientX, event.clientY), null);
      setSelection(derived);
      setAnchor(derived ? anchorFor(hit, derived) : null);
    };

    // Capture and passive, and no preventDefault anywhere — see the header.
    const options = { capture: true, passive: true } as const;
    container.addEventListener("pointerdown", onPointerDown, options);
    container.addEventListener("pointerup", onPointerUp, options);
    container.addEventListener("dblclick", onDoubleClick, options);
    return () => {
      container.removeEventListener("pointerdown", onPointerDown, options);
      container.removeEventListener("pointerup", onPointerUp, options);
      container.removeEventListener("dblclick", onDoubleClick, options);
    };
  }, [enabled, containerRef, editorRef, clear]);

  return { selection, anchor, clear };
}
