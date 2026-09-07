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

import { type BlockRef, type CharAnchor, buildCharAnchors } from "@/internal/bandGeometry";
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
  /**
   * Per-character line and x positions from the seeding snapshot, which is what lets vertical
   * caret movement be tracked at all — Up/Down move by LINE, and a line is a fact about
   * layout, not about text.
   */
  anchors: readonly CharAnchor[];
  /**
   * True once an accepted edit has changed the text, because `anchors` then describes the
   * layout of text that no longer exists.
   *
   * Horizontal movement survives this (Left/Right are ±1 in text space and need no geometry).
   * Vertical movement does not, and re-deriving the anchors would need a fresh layout
   * snapshot — which is only available after the SDK re-lays the page out, i.e. not
   * synchronously inside a keydown handler.
   */
  geometryStale: boolean;
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
    anchors: charAnchors,
    geometryStale: false,
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
    geometryStale: true,
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
    geometryStale: true,
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
    geometryStale: true,
  };
}

/** Keys this model tries to follow rather than give up on. */
const NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

export function isNavigationKey(key: string): boolean {
  return NAVIGATION_KEYS.has(key);
}

/** The line a caret index sits on, and its x — the two things vertical movement needs. */
function lineAndXAt(caret: CaretState, index: number): { line: number; x: number } | null {
  const { anchors } = caret;
  if (anchors.length === 0) return null;
  // A caret at index i sits before the character at i. At the very end of the block there is
  // no character there, so take the last one's right edge instead.
  if (index >= anchors.length) {
    const last = anchors[anchors.length - 1];
    return { line: last.lineIndex, x: last.xRight };
  }
  const at = anchors[Math.max(0, index)];
  return { line: at.lineIndex, x: at.xLeft };
}

/** Caret indices that fall on `line`, as a [first, lastExclusive] pair. */
function lineBounds(caret: CaretState, line: number): { first: number; last: number } | null {
  const { anchors } = caret;
  let first = -1;
  let last = -1;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].lineIndex !== line) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return null;
  // `last + 1` is the caret position after the line's final character.
  return { first, last: last + 1 };
}

/** The caret index on `line` nearest the x position `x`. */
function indexNearestX(caret: CaretState, line: number, x: number): number | null {
  const bounds = lineBounds(caret, line);
  if (!bounds) return null;
  let best = bounds.first;
  let bestDistance = Infinity;
  for (let i = bounds.first; i < bounds.last; i++) {
    const distance = Math.abs(caret.anchors[i].xLeft - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  // The position after the line's last character is a caret position too.
  const tail = caret.anchors[bounds.last - 1];
  if (tail && Math.abs(tail.xRight - x) < bestDistance) best = bounds.last;
  return best;
}

/**
 * Follow a navigation key, or return null when the caret would leave what we can account for.
 *
 * This is caret navigation, reimplemented. The SDK does it internally and reports nothing, so
 * the only way to keep a shadow caret alive through an arrow key is to redo the work against
 * the same layout data the band painter uses:
 *
 *   · Left/Right are ±1 in text space and need no geometry at all, so they survive an edit.
 *   · Up/Down move by LINE, which is a fact about layout — they need `anchors`, and therefore
 *     fail once an accepted edit has made those stale.
 *   · Home/End are the ends of the current line, so they need `anchors` for the same reason.
 *
 * Null on: leaving the block at either end (the caret moves into a paragraph we have not
 * snapshotted), and vertical or line-relative movement over stale geometry. Both are honest
 * limits rather than guesses — see `placeholderGuard.ts` for what null costs.
 */
export function moveCaret(caret: CaretState, key: string): CaretState | null {
  const { index, blockText } = caret;

  if (key === "ArrowLeft") {
    // Off the front of the block: the caret is now in the previous paragraph.
    return index <= 0 ? null : { ...caret, index: index - 1 };
  }
  if (key === "ArrowRight") {
    return index >= blockText.length ? null : { ...caret, index: index + 1 };
  }

  // Everything below needs the line structure.
  if (caret.geometryStale) return null;
  const here = lineAndXAt(caret, index);
  if (!here) return null;

  if (key === "Home" || key === "End") {
    const bounds = lineBounds(caret, here.line);
    if (!bounds) return null;
    return { ...caret, index: key === "Home" ? bounds.first : bounds.last };
  }

  if (key === "ArrowUp" || key === "ArrowDown") {
    const targetLine = here.line + (key === "ArrowUp" ? -1 : 1);
    // Above the first line or below the last one, the caret leaves this block.
    const moved = indexNearestX(caret, targetLine, here.x);
    return moved === null ? null : { ...caret, index: moved };
  }

  return null;
}

/**
 * Keys after which the model gives up outright.
 *
 * Navigation is handled by `moveCaret` above, so what is left here is the genuinely
 * untrackable: keys that restructure the block, and modifier chords that could be any command
 * at all. Every one of these voids the model, and a void model is a guard that cannot decide.
 */
export function isUntrackable(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  return ["Enter", "Tab", "PageUp", "PageDown"].includes(event.key);
}
