// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 02 · A — "Screen position of a text block or selection".
//
//  Every type in this file describes a shape that appears in NO published type definition.
//  It exists because the SDK renders text as SVG glyphs and the public API returns no
//  geometry, so the only way to put a highlight behind a word is to re-derive the word's
//  rectangle from the SDK's own layout tree. `placeholders.get(key).rects()` would delete
//  this file.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// Pure geometry for the placeholder overlay: walks the Nutrient Document Authoring SDK's
// INTERNAL layout snapshot and emits pixel rects for a target text token.
//
// The shape below is reverse-engineered. Verified empirically against SDK 1.17.0 and
// re-verified against 1.19.1 — see the fixture README in __fixtures__/ for how to re-verify:
//   contentArea { offset{x,y}, extent{x,y}, bodyParts[] }
//     bodyPart { offset{y}, extent{y}, lines[], rows[] (tables) }
//       line { offset{y}=BASELINE, extent{y}=line-advance box, lineSpacing{top,bottom}, segments[] }
//         segment { offset{x}, elements[] }
//           element { offset{x}, vanishing, input{ type, advances[] (per-glyph pt), source.runs[].text } }
//
// Free of React and the DOM so the rect math unit-tests without a browser.

/** A paintable rect in UNSCALED in-page px (the page div's natural box). */
export type TokenRect = { left: number; top: number; width: number; height: number };

/** A block's position in the document model (section + section-relative block index). */
export type BlockRef = {
  sectionIndex: number;
  blockIndex: number;
  /**
   * Which row of a table block the text sits in, or null for a paragraph. A table cell's
   * paragraphs are not top-level blocks, so the block ordinal alone cannot address them.
   */
  rowIndex?: number | null;
};

// Every field below is optional on purpose: the shape is reverse-engineered, so the walkers
// must tolerate drift by producing no rects rather than throwing.
export type LayoutElement = {
  offset?: { x?: number };
  vanishing?: boolean;
  input?: {
    type?: string;
    advances?: number[];
    clusters?: number;
    advanceX?: number;
    source?: { runs?: { text?: string }[] };
  };
};

export type LayoutSegment = {
  offset?: { x?: number };
  elements?: LayoutElement[];
};

export type LayoutLine = {
  offset?: { y?: number };
  /** The full line-advance box (taller than the glyph cell this module paints). */
  extent?: { y?: number };
  lineSpacing?: { top?: number; bottom?: number; gap?: number };
  segments?: LayoutSegment[];
};

/** A laid-out table row. Its cells nest a whole content area, so table text is NOT reachable
 * by a `bodyParts` walk — a table part carries `rows` and no `lines`, and yields no rects. */
/** A table cell's own content area: its parts are placed relative to the cell. */
export type LayoutCellContentArea = { offset?: { x?: number; y?: number }; bodyParts?: LayoutPart[] };

export type LayoutRow = {
  rowIdx?: number;
  offset?: { y?: number };
  extent?: { y?: number };
  cells?: { offset?: { x?: number; y?: number }; contentArea?: LayoutCellContentArea }[];
};

export type LayoutPart = {
  type?: string;
  partIdx?: number;
  blockLevelIdx?: number;
  offset?: { y?: number };
  extent?: { y?: number };
  lines?: LayoutLine[];
  rows?: LayoutRow[];
};

/**
 * One character's geometry within a block part: its visual line, its left/right x in part-local
 * pt, and that line's glyph-cell top/height. `char` is the literal glyph, except for the
 * synthetic zero-width space inserted at each soft-wrap boundary.
 */
export type CharAnchor = {
  char: string;
  xLeft: number;
  xRight: number;
  lineIndex: number;
  lineTop: number;
  lineHeight: number;
};

/** The page-local placement of a block part within its content area, in pt (+ the pt→px scale). */
export type PartPlacement = {
  caOffsetX: number;
  caOffsetY: number;
  partOffsetY: number;
  pxPerPt: number;
};

const WHITESPACE = /\s/;

// A quote-wrapped phrase, optionally preceded by "the" and/or wrapped in parentheses.
const QUOTED_REFERENCE_RE = /^(?:\(\s*)?(?:the\s+)?["“”']([^"“”'\n]{1,80})["“”'](?:\s*\))?$/i;
// Quote pairs within a block, used to detect a match sitting inside a defined term.
const QUOTED_PAIR_RE = /["“”']([^"“”'\n]{1,80})["“”']/g;

function isQuoteChar(ch: string): boolean {
  return ch === '"' || ch === "“" || ch === "”" || ch === "'";
}

/**
 * Text carried by a laid-out element. Three element types carry their character only in
 * their `type` and have no `runs` at all: `s` (space), `tab` and `break/line`. Mapping all
 * three is what keeps this text in step with the model's — see `buildCharAnchors`.
 */
function elementText(el: LayoutElement): string {
  const runs = el.input?.source?.runs;
  if (Array.isArray(runs)) return runs.map((r) => r.text ?? "").join("");
  switch (el.input?.type) {
    case "s":
      return " ";
    case "tab":
      return "\t";
    case "break/line":
      return "\n";
    default:
      return "";
  }
}

/**
 * Per-glyph advance widths (pt), or null when the element carries text but no width
 * information at all. Null must not degrade to zeros: element offsets alone still span a
 * plausible-looking rect, so fabricated widths paint a confidently wrong band.
 */
function elementAdvances(el: LayoutElement): number[] | null {
  const advances = el.input?.advances;
  if (Array.isArray(advances)) return advances;
  const advanceX = el.input?.advanceX;
  if (typeof advanceX !== "number" || !Number.isFinite(advanceX)) return null;
  const count = el.input?.clusters ?? 1;
  if (count <= 0) return [];
  return Array<number>(count).fill(advanceX / count);
}

/**
 * True when a match is the inner content of a quotation-mark defined term (`"Effective Date"`).
 * Those NAME a field rather than being a fill-in site, so the overlay must skip them.
 */
export function isMatchWrappedInQuotes(fullText: string, start: number, end: number): boolean {
  if (end <= start || start < 0 || end > fullText.length) return false;
  if (QUOTED_REFERENCE_RE.test(fullText.slice(start, end).trim())) return true;

  const before = start > 0 ? fullText[start - 1] : "";
  const after = end < fullText.length ? fullText[end] : "";
  if (isQuoteChar(before) && isQuoteChar(after)) return true;

  QUOTED_PAIR_RE.lastIndex = 0;
  for (let pair = QUOTED_PAIR_RE.exec(fullText); pair !== null; pair = QUOTED_PAIR_RE.exec(fullText)) {
    const innerStart = pair.index + 1;
    const innerEnd = innerStart + pair[1].length;
    if (start >= innerStart && end <= innerEnd) return true;
  }
  return false;
}

/**
 * The part's flat text plus a per-character anchor list, in part-local pt (x in segment/line
 * coords, y from the part top). Callers add the content-area and part offsets and multiply by
 * `pxPerPt` to reach page px.
 *
 * `fullText` is index-identical to the block's `getPlainText()`, which is what lets an offset
 * derived here be handed to the model. Reaching that took the vanishing-element rule below;
 * without it tabs vanished and a hard break lost two characters, so every offset after the
 * first one in the block addressed the wrong text. Nothing in the public API relates a
 * character offset to a document position — case ask 02 · B.
 */
export function buildCharAnchors(part: LayoutPart): {
  fullText: string;
  charAnchors: CharAnchor[];
  /** False when some text-carrying element exposed no width, so no rect here can be trusted. */
  measurable: boolean;
} {
  let fullText = "";
  let measurable = true;
  const charAnchors: CharAnchor[] = [];
  const lines = part.lines ?? [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const spacingTop = line.lineSpacing?.top ?? 0;
    const spacingBottom = line.lineSpacing?.bottom ?? 0;
    // `line.offset.y` is the BASELINE, not the cell top. Height is the tight glyph cell
    // (spacing top+bottom); `line.extent.y` is the taller full line-advance box, not this.
    const lineTop = (line.offset?.y ?? 0) - spacingTop;
    const lineHeight = spacingTop + spacingBottom;

    for (const segment of line.segments ?? []) {
      const segmentOffsetX = segment.offset?.x ?? 0;
      for (const element of segment.elements ?? []) {
        const text = elementText(element);
        if (text.length === 0) continue;
        // A vanishing element is INVISIBLE, not absent: it still carries characters the model
        // counts. Emitting them at zero width, pinned to where the line ended, keeps this text
        // index-identical to `getPlainText()` without ever widening a rect. Skipping them
        // instead dropped the space before a hard break and every tab — two model characters
        // at a hard break, not one — so every offset past the first one was wrong.
        const vanishing = Boolean(element.vanishing);
        const advances = vanishing ? null : elementAdvances(element);
        if (!vanishing && advances === null) measurable = false;
        // Pinned to the previous anchor's ABSOLUTE x, which already carries its own segment
        // offset — so a vanishing element takes the origin as-is rather than adding this
        // segment's offset on top of it. The zero-width anchors never reach a rect (see
        // `rectsForCharRange`), but `pointToCharIndex` measures against them.
        let cursorX = vanishing ? 0 : element.offset?.x ?? 0;
        const originX = vanishing ? (charAnchors[charAnchors.length - 1]?.xRight ?? 0) : segmentOffsetX;
        for (let k = 0; k < text.length; k++) {
          const advance = vanishing ? 0 : (advances?.[k] ?? 0);
          charAnchors.push({
            char: text[k],
            lineIndex: li,
            xLeft: originX + cursorX,
            xRight: originX + cursorX + advance,
            lineTop,
            lineHeight,
          });
          fullText += text[k];
          cursorX += advance;
        }
      }
    }
  }

  return { fullText, charAnchors, measurable };
}

/**
 * Covering rects (UNSCALED in-page px) for the char range [start, end), one per visual line:
 * per line, min xLeft to max xRight over the range's anchors.
 */
export function rectsForCharRange(
  charAnchors: CharAnchor[],
  start: number,
  end: number,
  placement: PartPlacement,
): TokenRect[] {
  const byLine = new Map<number, { xLeft: number; xRight: number; top: number; height: number }>();
  for (let i = Math.max(0, start); i < end && i < charAnchors.length; i++) {
    const anchor = charAnchors[i];
    if (WHITESPACE.test(anchor.char) && anchor.xRight <= anchor.xLeft) continue;
    const group = byLine.get(anchor.lineIndex) ?? {
      xLeft: Infinity,
      xRight: -Infinity,
      top: anchor.lineTop,
      height: anchor.lineHeight,
    };
    group.xLeft = Math.min(group.xLeft, anchor.xLeft);
    group.xRight = Math.max(group.xRight, anchor.xRight);
    byLine.set(anchor.lineIndex, group);
  }

  const rects: TokenRect[] = [];
  for (const group of byLine.values()) {
    if (!Number.isFinite(group.xLeft) || !Number.isFinite(group.xRight) || group.xRight <= group.xLeft) continue;
    rects.push({
      left: (placement.caOffsetX + group.xLeft) * placement.pxPerPt,
      top: (placement.caOffsetY + placement.partOffsetY + group.top) * placement.pxPerPt,
      width: (group.xRight - group.xLeft) * placement.pxPerPt,
      height: group.height * placement.pxPerPt,
    });
  }
  return rects;
}

export type PartTokenRects = {
  rects: TokenRect[];
  /** DISTINCT matches — never `rects.length`, which is per visual line. */
  occurrences: number;
  /** The rects of each distinct match, in text order (one match can span visual lines). */
  occurrenceRects: TokenRect[][];
  /**
   * Matches the quoted-defined-term rule deliberately dropped. Lets a caller tell "excluded by
   * design" from "could not resolve" — a no-band outcome that is correct, not a failure.
   */
  excludedByQuotes: number;
};

/**
 * Word-tight rects for every occurrence of `tokenText` within one laid-out block part.
 *
 * Matches on the NON-WHITESPACE skeleton so a token still resolves across the synthetic
 * soft-wrap space and through respaced markers (`{{key}}` vs `{{ key }}`). Case-SENSITIVE, so a
 * field labelled "Service type" does not paint over prose "service type".
 */
export function computeTokenRectsForPart(
  part: LayoutPart,
  tokenText: string,
  placement: PartPlacement,
): PartTokenRects {
  const empty: PartTokenRects = { rects: [], occurrences: 0, occurrenceRects: [], excludedByQuotes: 0 };
  const needle = tokenText.replace(/\s+/g, "");
  if (!needle) return empty;

  const { fullText, charAnchors, measurable } = buildCharAnchors(part);
  if (!measurable) return empty;

  // Index of the j-th non-whitespace char within fullText, to map a skeleton hit back to anchors.
  const skeletonToFull: number[] = [];
  let skeleton = "";
  for (let i = 0; i < fullText.length; i++) {
    if (!WHITESPACE.test(fullText[i])) {
      skeleton += fullText[i];
      skeletonToFull.push(i);
    }
  }

  const rects: TokenRect[] = [];
  const occurrenceRects: TokenRect[][] = [];
  let occurrences = 0;
  let excludedByQuotes = 0;
  let searchFrom = 0;
  for (let hit = skeleton.indexOf(needle); hit >= 0; hit = skeleton.indexOf(needle, searchFrom)) {
    const hitEnd = hit + needle.length;
    searchFrom = hitEnd;
    const start = skeletonToFull[hit];
    const end = skeletonToFull[hitEnd - 1] + 1;
    if (isMatchWrappedInQuotes(fullText, start, end)) {
      excludedByQuotes++;
      continue;
    }
    occurrences++;
    const matchRects = rectsForCharRange(charAnchors, start, end, placement);
    occurrenceRects.push(matchRects);
    rects.push(...matchRects);
  }
  return { rects, occurrences, occurrenceRects, excludedByQuotes };
}
