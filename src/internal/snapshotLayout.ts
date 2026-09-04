// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 02 · A — "Screen position of a text block or selection".
//
//  The single most load-bearing hack in the demo: `getDocumentContext` below reaches the
//  SDK's internal document context through a `Symbol()` key, matched by the SHAPE of its
//  value because its description has already been renamed once. Everything the overlay
//  draws depends on that probe continuing to work.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// Reaching the Nutrient Document Authoring SDK's layout snapshot and its shadow-DOM page
// divs, and locating a token's rects within them. The rect math itself lives in
// bandGeometry.ts (DOM-free).
//
// Verified against SDK 1.17.0 and re-verified against 1.19.1; re-verify on upgrade (see
// __fixtures__/README.md).
import type { DocAuthEditor } from "@nutrient-sdk/document-authoring";

import {
  type LayoutPart,
  type PartPlacement,
  type TokenRect,
  computeTokenRectsForPart,
} from "@/internal/bandGeometry";
// Re-exported so overlay callers import one module.
import { findPageDivs, findViewport, pageBoxWidthPx } from "@/internal/shadowDom";
import { trace } from "@/internal/trace";

export { findPageDivs, findViewport, pageBoxWidthPx };

const PT_TO_PX = 96 / 72;

export type LayoutContentArea = {
  offset?: { x?: number; y?: number };
  extent?: { x?: number; y?: number };
  bodyParts?: LayoutPart[];
  shadow?: { bodyParts?: LayoutPart[] };
};

export type LayoutPage = { contentAreas?: LayoutContentArea[] };

export type LayoutSection = { pages?: LayoutPage[] };

export type DocumentContext = {
  shadowState?: { snapshot?: () => { shadow?: { body?: LayoutSection[] } } | undefined };
};

/**
 * The SDK-internal documentContext, hung off a `Symbol()` property of the document.
 *
 * The symbol is matched by the SHAPE of its value, never its description: the SDK renamed it
 * `DocAuthImpl` → `DocAuthHeadlessImpl`, so a description filter breaks on upgrade and does so
 * silently (null context, overlay paints nothing). Same probe as NutrientDocxEditor's.
 */
export function getDocumentContext(editor: DocAuthEditor): DocumentContext | null {
  const doc = editor.currentDocument();
  trace({
    capability: "paint",
    reach: "symbol-probe",
    touched: "Object.getOwnPropertySymbols(doc) → […].documentContext",
    because:
      "The layout tree is only reachable through a Symbol()-keyed internal impl. The symbol's description was already renamed once (DocAuthImpl → DocAuthHeadlessImpl), so it is matched by the shape of its value instead.",
    ask: "02 · A",
  });
  for (const symbol of Object.getOwnPropertySymbols(doc)) {
    const container = (doc as unknown as Record<symbol, { documentContext?: DocumentContext } | undefined>)[symbol];
    if (container?.documentContext) return container.documentContext;
  }
  return null;
}

export function contentAreaParts(ca: LayoutContentArea): LayoutPart[] | null {
  const bodyParts = ca.bodyParts ?? ca.shadow?.bodyParts;
  return Array.isArray(bodyParts) ? bodyParts : null;
}

export type ContentAreaPlacement = { caOffsetX: number; caOffsetY: number; pxPerPt: number };

/**
 * Where a content area sits on its page and the page's pt→px scale. The page width is the
 * content area's own extent plus its symmetric side insets; dividing the rendered div width by
 * it gives the zoom-dependent scale (Letter: 816px / 612pt = 1.3333).
 */
export function contentAreaPlacement(ca: LayoutContentArea, pageDivWidthPx: number): ContentAreaPlacement {
  const caOffsetX = ca.offset?.x ?? 0;
  const caOffsetY = ca.offset?.y ?? 0;
  const caExtentX = ca.extent?.x ?? 0;
  const pageWidthPt = caOffsetX * 2 + caExtentX;
  const pxPerPt = pageWidthPt > 0 && pageDivWidthPx > 0 ? pageDivWidthPx / pageWidthPt : PT_TO_PX;
  return { caOffsetX, caOffsetY, pxPerPt };
}

/** Why a token that should have resolved produced no rects. */
export type ResolutionFailureReason =
  /** No reachable documentContext — the SDK's internal symbol/shape has moved. */
  | "no-document-context"
  /** documentContext reached, but its layout snapshot was not a usable section array. */
  | "no-layout-snapshot"
  /** The target block was located and laid out, but the token matched nothing in it. */
  | "token-not-in-block"
  /** No laid-out part carried the target block at all. */
  | "block-not-laid-out";

// One report per (reason, token) per page load: a stuck document would otherwise report on
// every sync tick. Capped so a pathological document cannot grow this without bound.
const MAX_REPORTED_FAILURES = 64;
const reportedFailures = new Set<string>();

/**
 * A token resolution degraded to no rects. Every walker here fails soft — it returns null
 * rather than throwing — so without this an SDK shape change ships as a silently dead
 * overlay. In production this is an error-reporting call; here it feeds the trace, because
 * "the overlay needs its own drift alarm" is itself part of what the case is asking about.
 */
export function reportTokenResolutionFailure(
  reason: ResolutionFailureReason,
  detail: { tokenText: string; blockIndex?: number; sectionIndex?: number },
): void {
  const dedupeKey = `${reason}|${detail.tokenText}`;
  if (reportedFailures.has(dedupeKey) || reportedFailures.size >= MAX_REPORTED_FAILURES) return;
  reportedFailures.add(dedupeKey);
  console.warn("Placeholder overlay: token did not resolve to any rect", reason, detail.tokenText);
}

/**
 * A token resolved to nothing because every occurrence of it was a quoted defined term. That is
 * the exclusion working, so it is not reported as a failure — but a field with no band and no
 * explanation is its own trap, so say so once in the console for whoever is debugging it.
 */
function reportTokenExcludedByDesign(detail: { tokenText: string; sectionIndex: number; blockIndex: number }): void {
  const dedupeKey = `excluded-by-design|${detail.tokenText}`;
  if (reportedFailures.has(dedupeKey) || reportedFailures.size >= MAX_REPORTED_FAILURES) return;
  reportedFailures.add(dedupeKey);
  console.debug(
    "Placeholder overlay: no band — every occurrence names a defined term (quoted), which is not a fill-in site",
    detail,
  );
}

export type TokenRects = {
  pageIndex: number;
  rects: TokenRect[];
  /** DISTINCT occurrences — a single soft-wrapped occurrence yields several rects. */
  occurrences: number;
  occurrenceRects: TokenRect[][];
};

/**
 * Word-tight rects (UNSCALED in-page px) for `tokenText` within the block at
 * (targetSectionIndex, targetBlockIndex), or null when the block or the token can't be located.
 *
 * Null means the caller paints NOTHING for that token — never a page-wide band. A full-width
 * fallback band was the prototype's most visible bug, and a wrong band is worse than none.
 */
export function findTokenRects(
  documentContext: DocumentContext,
  /** Diagnostics only — block ordinals are body-global, so this no longer selects a section. */
  targetSectionIndex: number,
  targetBlockIndex: number,
  tokenText: string,
  pageDivWidthPx: number,
  /** Row of a table block, or null/undefined for a paragraph. */
  targetRowIndex: number | null = null,
): TokenRects | null {
  if (!tokenText) return null;
  trace({
    capability: "paint",
    reach: "layout-snapshot",
    touched: "documentContext.shadowState.snapshot().shadow.body → sections[].pages[].contentAreas[].bodyParts[]",
    because:
      "No public type describes this tree. Rects are re-derived from per-glyph advances by walking it — six nested levels of field names that no type definition mentions.",
    ask: "02 · A",
  });
  const body = documentContext.shadowState?.snapshot?.()?.shadow?.body;
  if (!Array.isArray(body)) {
    reportTokenResolutionFailure("no-layout-snapshot", { tokenText });
    return null;
  }

  let globalPageIndex = 0;
  let blockFound = false;
  let excludedByDesign = false;

  // Body-global, NOT per section. Since SDK 1.15 block content hangs off one `body.content()`, so
  // the ordinal a `BlockRef` carries counts straight through the section groups — see
  // `BODY_GLOBAL_SECTION_INDEX` in `scanBlocks`. Counting per section instead made every block
  // after a section break unresolvable: refs are all stamped section 0, so a `si !== 0` skip
  // discarded the rest of the document (a landscape schedule, a re-headered annex).
  //
  // Also NOT per page: a block split across a page boundary continues on the next page, so
  // resetting anywhere below would renumber every block after the first split.
  let currentBlock = -1;

  for (let si = 0; si < body.length; si++) {
    const section = body[si];
    if (!Array.isArray(section?.pages)) continue;

    for (const page of section.pages) {
      if (!Array.isArray(page.contentAreas)) {
        globalPageIndex++;
        continue;
      }

      for (const ca of page.contentAreas) {
        const bodyParts = contentAreaParts(ca);
        if (!bodyParts) continue;
        const { caOffsetX, caOffsetY, pxPerPt } = contentAreaPlacement(ca, pageDivWidthPx);

        for (const part of bodyParts) {
          if (part.partIdx === 0) currentBlock++;
          if (currentBlock > targetBlockIndex) break;
          // Accept ANY laid-out part (paragraph, title, heading, list item) so the overlay
          // paints in headings too. A table part carries `rows`, not `lines`, and is skipped.
          if (currentBlock !== targetBlockIndex) continue;

          // A table part carries `rows` and no `lines`: its text lives in each cell's own content
          // area. Walking in is what puts a band on a signature block.
          if (targetRowIndex !== null && Array.isArray(part.rows)) {
            const row = part.rows.find((candidate) => candidate.rowIdx === targetRowIndex) ?? part.rows[targetRowIndex];
            if (!row) continue;
            blockFound = true;
            const rowOffsetY = row.offset?.y ?? 0;
            for (const cell of row.cells ?? []) {
              const cellParts = cell.contentArea?.bodyParts;
              if (!Array.isArray(cellParts)) continue;
              for (const cellPart of cellParts) {
                if (!Array.isArray(cellPart.lines) || cellPart.lines.length === 0) continue;
                // Offsets nest: content area → table part → row → cell → the cell's own part.
                const cellPlacement: PartPlacement = {
                  caOffsetX: caOffsetX + (cell.offset?.x ?? 0) + (cell.contentArea?.offset?.x ?? 0),
                  caOffsetY: caOffsetY + (part.offset?.y ?? 0) + rowOffsetY + (cell.offset?.y ?? 0),
                  partOffsetY: (cell.contentArea?.offset?.y ?? 0) + (cellPart.offset?.y ?? 0),
                  pxPerPt,
                };
                const cellResult = computeTokenRectsForPart(cellPart, tokenText, cellPlacement);
                if (cellResult.excludedByQuotes > 0) excludedByDesign = true;
                if (cellResult.rects.length > 0) {
                  return {
                    pageIndex: globalPageIndex,
                    rects: cellResult.rects,
                    occurrences: cellResult.occurrences,
                    occurrenceRects: cellResult.occurrenceRects,
                  };
                }
              }
            }
            continue;
          }

          if (!Array.isArray(part.lines) || part.lines.length === 0) continue;
          blockFound = true;
          const placement: PartPlacement = {
            caOffsetX,
            caOffsetY,
            partOffsetY: part.offset?.y ?? 0,
            pxPerPt,
          };
          const { rects, occurrences, occurrenceRects, excludedByQuotes } = computeTokenRectsForPart(
            part,
            tokenText,
            placement,
          );
          if (excludedByQuotes > 0) excludedByDesign = true;
          if (rects.length > 0) return { pageIndex: globalPageIndex, rects, occurrences, occurrenceRects };
        }
      }
      globalPageIndex++;
    }
  }

  // An exclusion is not a failure. Reporting it would spend the reporter's per-token dedupe
  // slot and permanently mute the diagnostic for a genuine failure of the same token later.
  if (excludedByDesign) {
    reportTokenExcludedByDesign({ tokenText, sectionIndex: targetSectionIndex, blockIndex: targetBlockIndex });
    return null;
  }

  reportTokenResolutionFailure(blockFound ? "token-not-in-block" : "block-not-laid-out", {
    tokenText,
    sectionIndex: targetSectionIndex,
    blockIndex: targetBlockIndex,
  });
  return null;
}

/** A block's page placement (pt) — enough to steer the viewport toward a block whose rects
 * aren't paintable yet because its page hasn't been laid out. */
export type BlockPageCoordinate = { pageIndex: number; topPt: number; pageWidthPt: number };

/**
 * The global page index and top offset (pt) of the block at (targetSectionIndex,
 * targetBlockIndex). Null when its page hasn't been laid out yet — the SDK lays pages out as
 * the viewport approaches them, so callers scroll toward the last laid-out page and retry.
 */
export function findBlockPageCoordinates(
  documentContext: DocumentContext,
  /** Unused: block ordinals are body-global. Kept so both walkers share one call shape. */
  _targetSectionIndex: number,
  targetBlockIndex: number,
): BlockPageCoordinate | null {
  const body = documentContext.shadowState?.snapshot?.()?.shadow?.body;
  if (!Array.isArray(body)) return null;

  let globalPageIndex = 0;
  // Body-global, for the same reason as `findTokenRects` above.
  let currentBlock = -1;

  for (let si = 0; si < body.length; si++) {
    const section = body[si];
    if (!Array.isArray(section?.pages)) continue;

    for (const page of section.pages) {
      if (!Array.isArray(page.contentAreas)) {
        globalPageIndex++;
        continue;
      }

      for (const ca of page.contentAreas) {
        const bodyParts = contentAreaParts(ca);
        if (!bodyParts) continue;
        const caOffsetX = ca.offset?.x ?? 0;
        const caOffsetY = ca.offset?.y ?? 0;
        const caExtentX = ca.extent?.x ?? 0;

        for (const part of bodyParts) {
          if (part.partIdx === 0) currentBlock++;
          if (currentBlock > targetBlockIndex) break;
          // A block split across pages has later parts elsewhere; its first part is where to
          // scroll to.
          if (currentBlock === targetBlockIndex) {
            return {
              pageIndex: globalPageIndex,
              topPt: caOffsetY + (part.offset?.y ?? 0),
              pageWidthPt: caOffsetX * 2 + caExtentX,
            };
          }
        }
      }
      globalPageIndex++;
    }
  }
  return null;
}
