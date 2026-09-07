// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 01 · property 1 — "the user cannot partially edit it", which the
//  case calls "the one that matters most".
//
//  To refuse a keystroke that would damage a placeholder, you have to know where the caret
//  is. The SDK will not say. The entire public surface is:
//
//      hasActiveCursor(): boolean          // yes/no. Not where.
//      getSelectionContent(): Content      // what is selected. Not where it is.
//
//  So this file maintains a SHADOW CARET: a hand-kept model of where we believe the caret is,
//  seeded from a click (hit-tested against the layout tree, exactly as the selection code
//  does) and then advanced by every keystroke we allow through.
//
//  It has to be synchronous. A `keydown` handler cannot await, and reading the document's text
//  needs a transaction — so the block's text and its marker positions are snapshotted at seed
//  time and maintained locally after that. Everything below is a consequence of that.
//
//  The model is DELIBERATELY fragile in a visible way: anything it cannot account for sets it
//  to null rather than guessing. `null` means "we do not know where the caret is", and a guard
//  built on it can then only choose between refusing every edit or allowing a damaging one.
//  That choice is the substance of the ask.
// ─────────────────────────────────────────────────────────────────────────────────────────
import type { DocAuthEditor } from "@nutrient-sdk/document-authoring";

import { type BlockRef, buildCharAnchors } from "@/internal/bandGeometry";
import { pointToCharIndex, resolveBlockAtPoint } from "@/internal/selectionGeometry";
import { findPageDivs, getDocumentContext, pageBoxWidthPx } from "@/internal/snapshotLayout";
import { trace } from "@/internal/trace";

/** A `{{ key }}` marker's span within a block's text. */
export type MarkerRange = { start: number; end: number; text: string };

/** Where we believe the caret is, plus the synchronous snapshot a guard needs. */
export type CaretState = {
  blockRef: BlockRef;
  /**
   * Character index in the block's text — a caret position, so it ranges over
   * [0, blockText.length]. Same index space as `getPlainText()`, which is only true because
   * of the vanishing-element rule in `buildCharAnchors`; without it every index past the
   * first tab or hard break in the block would be wrong.
   */
  index: number;
  /** The block's text as of the last seed, with accepted edits applied. */
  blockText: string;
  /** Marker spans within `blockText`, maintained as accepted edits shift them. */
  markers: readonly MarkerRange[];
  /** Which page the seeding click landed on, for diagnostics. */
  pageIndex: number;
};

const MARKER_RE = /\{\{[^{}]*\}\}/g;

/** Every `{{ … }}` span in a block's text. */
export function markerRanges(text: string): MarkerRange[] {
  const found: MarkerRange[] = [];
  MARKER_RE.lastIndex = 0;
  for (let hit = MARKER_RE.exec(text); hit !== null; hit = MARKER_RE.exec(text)) {
    found.push({ start: hit.index, end: hit.index + hit[0].length, text: hit[0] });
  }
  return found;
}

/** A point in a page div's natural (unzoomed) coordinate space. */
type PageLocalPoint = { x: number; y: number };

function pageDivAt(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): { pageIndex: number; pageDiv: HTMLElement } | null {
  const pageDivs = findPageDivs(container);
  for (let pageIndex = 0; pageIndex < pageDivs.length; pageIndex++) {
    const rect = pageDivs[pageIndex].getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return { pageIndex, pageDiv: pageDivs[pageIndex] };
    }
  }
  return null;
}

function toPageLocal(pageDiv: HTMLElement, clientX: number, clientY: number): PageLocalPoint {
  const rendered = pageDiv.getBoundingClientRect();
  const scaleX = pageDiv.offsetWidth > 0 ? rendered.width / pageDiv.offsetWidth : 1;
  const scaleY = pageDiv.offsetHeight > 0 ? rendered.height / pageDiv.offsetHeight : 1;
  return {
    x: scaleX > 0 ? (clientX - rendered.left) / scaleX : 0,
    y: scaleY > 0 ? (clientY - rendered.top) / scaleY : 0,
  };
}

/**
 * Seed the shadow caret from a click, by hit-testing the point against the layout tree.
 *
 * This is the same arithmetic the selection code uses, and it was measured against ground
 * truth — click where this says index i is, type a sentinel, read the model back — at
 * 8/10 exact on a fixture built specifically to break it. The two failures were both the
 * tab/hard-break index-space bug that `buildCharAnchors` now fixes.
 *
 * Returns null when the point is over no laid-out block, or the block exposed no glyph
 * widths. Null is the honest answer; a guessed caret produces a guard that blocks the wrong
 * keystrokes.
 */
export function seedCaretFromClick(
  editor: DocAuthEditor,
  container: HTMLElement,
  clientX: number,
  clientY: number,
): CaretState | null {
  const hit = pageDivAt(container, clientX, clientY);
  if (!hit) return null;
  const documentContext = getDocumentContext(editor);
  if (!documentContext) return null;

  trace({
    capability: "caret",
    reach: "layout-snapshot",
    touched: "seedCaretFromClick — pointToCharIndex over the internal layout tree, because the caret is not readable",
    because:
      "hasActiveCursor() is a bare boolean and getSelectionContent() returns content without a position. Knowing where the caret is — the precondition for refusing a keystroke — means hit-testing the click ourselves and then tracking it by hand.",
    ask: "01 · 1",
  });

  const pageDivWidthPx = pageBoxWidthPx(hit.pageDiv);
  const point = toPageLocal(hit.pageDiv, clientX, clientY);
  const block = resolveBlockAtPoint(documentContext, hit.pageIndex, point, pageDivWidthPx);
  if (!block) return null;

  const { fullText, charAnchors, measurable } = buildCharAnchors(block.part);
  if (!measurable || charAnchors.length === 0) return null;

  const { placement } = block;
  const index = pointToCharIndex(
    charAnchors,
    point.x / placement.pxPerPt - placement.caOffsetX,
    point.y / placement.pxPerPt - placement.caOffsetY - placement.partOffsetY,
  );

  return {
    blockRef: block.blockRef,
    index: Math.max(0, Math.min(index, fullText.length)),
    blockText: fullText,
    markers: markerRanges(fullText),
    pageIndex: hit.pageIndex,
  };
}

/** Shift every marker span at or after `at` by `delta`. */
function shiftMarkers(markers: readonly MarkerRange[], at: number, delta: number): MarkerRange[] {
  return markers.map((marker) =>
    marker.start >= at
      ? { ...marker, start: marker.start + delta, end: marker.end + delta }
      : marker.end > at
        ? { ...marker, end: marker.end + delta }
        : marker,
  );
}

/**
 * Apply an accepted single-character insertion to the shadow caret.
 *
 * The whole local model has to move: the text, the caret, and every marker span after it.
 * Skipping the marker shift is not cosmetic — the next keystroke's decision is made against
 * these ranges, so a stale range means blocking a keystroke that is now clear of the marker,
 * or allowing one that is now inside it.
 */
export function acceptInsertion(caret: CaretState, char: string): CaretState {
  const { index, blockText } = caret;
  return {
    ...caret,
    blockText: blockText.slice(0, index) + char + blockText.slice(index),
    index: index + 1,
    markers: shiftMarkers(caret.markers, index, char.length),
  };
}

/** Apply an accepted backspace. Returns the caret unchanged at the start of the block. */
export function acceptBackspace(caret: CaretState): CaretState {
  const { index, blockText } = caret;
  if (index <= 0) return caret;
  return {
    ...caret,
    blockText: blockText.slice(0, index - 1) + blockText.slice(index),
    index: index - 1,
    markers: shiftMarkers(caret.markers, index, -1),
  };
}

/** Apply an accepted forward delete. Returns the caret unchanged at the end of the block. */
export function acceptDelete(caret: CaretState): CaretState {
  const { index, blockText } = caret;
  if (index >= blockText.length) return caret;
  return {
    ...caret,
    blockText: blockText.slice(0, index) + blockText.slice(index + 1),
    markers: shiftMarkers(caret.markers, index + 1, -1),
  };
}

/**
 * Keys after which we no longer know where the caret is.
 *
 * Arrow keys and Home/End move it by an amount that depends on the LINE layout, not the text,
 * so tracking them would mean reimplementing line-breaking as well. Enter and Tab restructure
 * the block. Anything with a modifier could be any command at all.
 *
 * Every one of these forces the model to null, and a null model is a guard that cannot decide.
 * This list is the honest size of the problem: it is not that the caret is hard to find once,
 * it is that it cannot be kept.
 */
export function isUntrackable(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  return [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Enter",
    "Tab",
  ].includes(event.key);
}
