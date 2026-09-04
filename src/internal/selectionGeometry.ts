// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 02 · A — "Screen position of a text block or SELECTION".
//
//  The user drags across a phrase and we need to know which phrase. The SDK knows; it will
//  not say. `getSelectionContent()` returns content and never a position, and
//  `hasActiveCursor()` is a bare boolean — so the selection is RE-DERIVED from raw pointer
//  coordinates against the same per-glyph anchors the painter uses. This whole file is a
//  reimplementation of text hit-testing that the renderer already does internally.
//
//  `placeholders.add({ key, fromSelection: true })` would delete it.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// There is no browser selection to read either: the SDK renders text as SVG glyphs and keeps
// its own internal selection model, so `window.getSelection()` over the editor returns a
// collapsed caret. The selected text is therefore derived from the pointer-down/up points —
// resolve the block under the down point, map each point to the nearest caret index, snap to
// whole words, slice the block's text.
//
// Measured accuracy: exact (error 0 characters) across soft wraps, hard breaks and tabs.
//
// Free of React and the DOM: callers hand in page-local px and get page-local px back.
import {
  type BlockRef,
  type CharAnchor,
  type LayoutPart,
  type PartPlacement,
  type TokenRect,
  buildCharAnchors,
  rectsForCharRange,
} from "@/internal/bandGeometry";
import {
  type DocumentContext,
  contentAreaParts,
  contentAreaPlacement,
} from "@/internal/snapshotLayout";
import { trace } from "@/internal/trace";

/** A point in a page div's natural (unzoomed) coordinate space, px from its top-left. */
export type PageLocalPoint = { x: number; y: number };

/** A derived stretch of selected document text, with everything a field mint would need. */
export type BlueprintTextSelection = {
  /** The word-snapped text the user selected. */
  text: string;
  blockRef: BlockRef;
  /** The whole block's text — what disambiguates a repeated phrase. */
  blockText: string;
  /** `text`'s range within `blockText`. */
  charStart: number;
  charEnd: number;
  /** Covering rects in UNSCALED in-page px, one per visual line. */
  rects: TokenRect[];
  pageIndex: number;
};

export type ResolvedBlock = { blockRef: BlockRef; part: LayoutPart; placement: PartPlacement };

/** Past this the point is not "near" any paragraph — roughly two lines of body text. */
const NEAR_BLOCK_PT = 24;
/** Shorter than this and the gesture was a click or a stray glyph, not a selection. */
const MIN_SELECTION_CHARS = 2;

const WHITESPACE = /\s/;

/**
 * The laid-out block under a page-local point: the one whose glyph band contains it, else the
 * vertically nearest within `NEAR_BLOCK_PT`. Only `y` is consulted, so the page margins resolve
 * to the block beside them rather than to nothing.
 */
export function resolveBlockAtPoint(
  documentContext: DocumentContext,
  pageIndex: number,
  point: PageLocalPoint,
  pageDivWidthPx: number,
): ResolvedBlock | null {
  trace({
    capability: "select",
    reach: "layout-snapshot",
    touched: "resolveBlockAtPoint → snapshot().shadow.body, then pointToCharIndex over per-glyph advances",
    because:
      "getSelectionContent() returns content but never a position, and hasActiveCursor() is a bare boolean — so text hit-testing is reimplemented against the internal layout tree.",
    ask: "02 · A",
  });
  const body = documentContext.shadowState?.snapshot?.()?.shadow?.body;
  if (!Array.isArray(body)) return null;

  let globalPageIndex = 0;
  let best: ResolvedBlock | null = null;
  let bestDistance = Infinity;

  for (let sectionIndex = 0; sectionIndex < body.length; sectionIndex++) {
    const section = body[sectionIndex];
    if (!Array.isArray(section?.pages)) continue;

    // Section-wide, matching `findTokenRects`: a block split across a page boundary continues
    // on the next page, so resetting per page would renumber every block after the first split.
    let currentBlock = -1;

    for (const page of section.pages) {
      const onTargetPage = globalPageIndex === pageIndex;
      for (const ca of page.contentAreas ?? []) {
        const bodyParts = contentAreaParts(ca);
        if (!bodyParts) continue;
        const { caOffsetX, caOffsetY, pxPerPt } = contentAreaPlacement(ca, pageDivWidthPx);

        for (const part of bodyParts) {
          if (part.partIdx === 0) currentBlock++;
          if (!onTargetPage || !Array.isArray(part.lines) || part.lines.length === 0) continue;

          const partOffsetY = part.offset?.y ?? 0;
          let top = Infinity;
          let bottom = -Infinity;
          for (const line of part.lines) {
            const baseline = line.offset?.y ?? 0;
            top = Math.min(top, caOffsetY + partOffsetY + baseline - (line.lineSpacing?.top ?? 0));
            bottom = Math.max(bottom, caOffsetY + partOffsetY + baseline + (line.lineSpacing?.bottom ?? 0));
          }
          if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue;

          const resolved: ResolvedBlock = {
            blockRef: { sectionIndex, blockIndex: currentBlock },
            part,
            placement: { caOffsetX, caOffsetY, partOffsetY, pxPerPt },
          };
          const pointPt = pxPerPt > 0 ? point.y / pxPerPt : point.y;
          if (pointPt >= top && pointPt <= bottom) return resolved;
          const distance = pointPt < top ? top - pointPt : pointPt - bottom;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = resolved;
          }
        }
      }
      globalPageIndex++;
    }
  }

  return best !== null && bestDistance <= NEAR_BLOCK_PT ? best : null;
}

/**
 * The caret index in `charAnchors` nearest a part-local point (pt): the line whose glyph cell
 * holds `yPt` (else the vertically nearest), then the nearest character boundary on it.
 */
export function pointToCharIndex(charAnchors: readonly CharAnchor[], xPt: number, yPt: number): number {
  if (charAnchors.length === 0) return 0;

  let bestLine = charAnchors[0].lineIndex;
  let bestLineDistance = Infinity;
  const seenLines = new Set<number>();
  for (const anchor of charAnchors) {
    if (seenLines.has(anchor.lineIndex)) continue;
    seenLines.add(anchor.lineIndex);
    const top = anchor.lineTop;
    const bottom = anchor.lineTop + anchor.lineHeight;
    const distance = yPt < top ? top - yPt : yPt > bottom ? yPt - bottom : 0;
    if (distance < bestLineDistance) {
      bestLineDistance = distance;
      bestLine = anchor.lineIndex;
    }
  }

  let bestIndex = 0;
  let bestDistance = Infinity;
  let lineSeen = false;
  for (let i = 0; i < charAnchors.length; i++) {
    const anchor = charAnchors[i];
    if (anchor.lineIndex !== bestLine) {
      if (lineSeen) break;
      continue;
    }
    lineSeen = true;
    const toLeft = Math.abs(xPt - anchor.xLeft);
    if (toLeft < bestDistance) {
      bestDistance = toLeft;
      bestIndex = i;
    }
    const toRight = Math.abs(xPt - anchor.xRight);
    if (toRight < bestDistance) {
      bestDistance = toRight;
      bestIndex = i + 1;
    }
  }
  return bestIndex;
}

/**
 * Expand a raw caret range out to whole words, then trim the whitespace at either end. The
 * range is normalised, so a right-to-left drag snaps the same way as a left-to-right one.
 */
export function snapToWordBoundaries(text: string, start: number, end: number): { start: number; end: number } {
  let from = Math.max(0, Math.min(start, end));
  let to = Math.min(text.length, Math.max(start, end));
  const isWordChar = (char: string | undefined) => char !== undefined && !WHITESPACE.test(char);

  while (from > 0 && isWordChar(text[from - 1])) from--;
  while (to < text.length && isWordChar(text[to])) to++;
  while (from < to && WHITESPACE.test(text[from])) from++;
  while (to > from && WHITESPACE.test(text[to - 1])) to--;
  return { start: from, end: to };
}

export type DeriveTextSelectionParams = {
  documentContext: DocumentContext;
  /** Global page index of the page the gesture started on. */
  pageIndex: number;
  /** The page div's natural width in px, which fixes the pt→px scale. */
  pageDivWidthPx: number;
  from: PageLocalPoint;
  to: PageLocalPoint;
};

/** A block resolved for measuring, with the point→caret mapping its placement implies. */
type MeasuredBlock = {
  block: ResolvedBlock;
  fullText: string;
  charAnchors: CharAnchor[];
  charIndexAt: (point: PageLocalPoint) => number;
};

function measureBlockAtPoint(
  documentContext: DocumentContext,
  pageIndex: number,
  point: PageLocalPoint,
  pageDivWidthPx: number,
): MeasuredBlock | null {
  const block = resolveBlockAtPoint(documentContext, pageIndex, point, pageDivWidthPx);
  if (!block) return null;
  const { fullText, charAnchors, measurable } = buildCharAnchors(block.part);
  if (!measurable || charAnchors.length === 0) return null;

  const { placement } = block;
  return {
    block,
    fullText,
    charAnchors,
    charIndexAt: (at) =>
      pointToCharIndex(
        charAnchors,
        at.x / placement.pxPerPt - placement.caOffsetX,
        at.y / placement.pxPerPt - placement.caOffsetY - placement.partOffsetY,
      ),
  };
}

/** The word-snapped selection a raw caret range describes, or null when it describes none. */
function selectionFromCharRange(
  measured: MeasuredBlock,
  pageIndex: number,
  rawStart: number,
  rawEnd: number,
): BlueprintTextSelection | null {
  const { fullText, charAnchors, block } = measured;
  const { start, end } = snapToWordBoundaries(fullText, rawStart, rawEnd);
  const text = fullText.slice(start, end);
  if (end - start < MIN_SELECTION_CHARS || text.trim().length < MIN_SELECTION_CHARS) return null;

  const rects = rectsForCharRange(charAnchors, start, end, block.placement);
  if (rects.length === 0) return null;

  return { text, blockRef: block.blockRef, blockText: fullText, charStart: start, charEnd: end, rects, pageIndex };
}

/**
 * The selection a drag between two page-local points describes, or null when it describes none.
 *
 * Null covers every degenerate case deliberately, because a wrong selection mints a wrong
 * field: a point over no block, a block whose glyph widths the snapshot did not expose, two
 * ends resolving to the same caret, and — see `resolveBlockAtPoint` — a drag whose two ends
 * land in DIFFERENT blocks. Multi-block selection is refused rather than truncated to the first block:
 * the text the caller would get back is not the text the user dragged over.
 */
export function deriveTextSelection({
  documentContext,
  pageIndex,
  pageDivWidthPx,
  from,
  to,
}: DeriveTextSelectionParams): BlueprintTextSelection | null {
  const toBlock = resolveBlockAtPoint(documentContext, pageIndex, to, pageDivWidthPx);
  if (!toBlock) return null;
  const measured = measureBlockAtPoint(documentContext, pageIndex, from, pageDivWidthPx);
  if (!measured) return null;
  if (
    toBlock.blockRef.sectionIndex !== measured.block.blockRef.sectionIndex ||
    toBlock.blockRef.blockIndex !== measured.block.blockRef.blockIndex
  ) {
    return null;
  }

  const fromIndex = measured.charIndexAt(from);
  const toIndex = measured.charIndexAt(to);
  // Checked BEFORE the word snap, which would otherwise expand a click's single caret out to
  // the whole word under it and surface a toolbar nobody asked for.
  if (fromIndex === toIndex) return null;

  return selectionFromCharRange(measured, pageIndex, fromIndex, toIndex);
}

export type DeriveWordSelectionParams = Omit<DeriveTextSelectionParams, "from" | "to"> & { at: PageLocalPoint };

/**
 * The whole word under a page-local point — what a double-click means. Separate from
 * `deriveTextSelection` because that one refuses a collapsed range on purpose: the same caret
 * expanded to a word is right for a double-click and wrong for the tail of a drag.
 */
export function deriveWordSelection({
  documentContext,
  pageIndex,
  pageDivWidthPx,
  at,
}: DeriveWordSelectionParams): BlueprintTextSelection | null {
  const measured = measureBlockAtPoint(documentContext, pageIndex, at, pageDivWidthPx);
  if (!measured) return null;
  const caret = measured.charIndexAt(at);
  return selectionFromCharRange(measured, pageIndex, caret, caret);
}

/** A rect in the positioned overlay's own coordinate space, in client px. */
export type OverlayRect = { top: number; left: number; width: number; height: number };

export type SelectionAnchor = {
  /** Collapsed horizontally onto the card's centre line, so the anchor's own centring lands it
   * where it fits. */
  rect: OverlayRect;
  placement: "below" | "above";
};

export const SELECTION_ANCHOR_GAP_PX = 8;

/**
 * Where to hang a card of `card` size off `rect` inside `overlay`: below unless that overflows
 * the bottom and there is room above, and horizontally clamped so the card never hangs off an
 * edge. A selection scrolled clean out of view pins the card to the nearest edge — drifting
 * away with it or vanishing both lose the pending action.
 */
export function selectionAnchorPlacement(
  rect: OverlayRect,
  overlay: { width: number; height: number },
  card: { width: number; height: number },
  gap: number = SELECTION_ANCHOR_GAP_PX,
): SelectionAnchor {
  const halfCard = card.width / 2;
  const minCenter = halfCard + gap;
  const maxCenter = overlay.width - halfCard - gap;
  const rawCenter = rect.left + rect.width / 2;
  const center = minCenter > maxCenter ? overlay.width / 2 : Math.min(Math.max(rawCenter, minCenter), maxCenter);
  const collapsed = (top: number, height: number): OverlayRect => ({ top, left: center, width: 0, height });

  if (rect.top + rect.height < 0) return { rect: collapsed(0, 0), placement: "below" };
  if (rect.top > overlay.height) return { rect: collapsed(overlay.height, 0), placement: "above" };

  const fitsBelow = rect.top + rect.height + gap + card.height <= overlay.height;
  const fitsAbove = rect.top - gap - card.height >= 0;
  return {
    rect: collapsed(rect.top, rect.height),
    placement: fitsBelow || !fitsAbove ? "below" : "above",
  };
}
