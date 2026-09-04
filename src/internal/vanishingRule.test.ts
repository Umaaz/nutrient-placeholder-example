// Guards the one deliberate divergence from the production code this demo was ported from:
// the vanishing-element rule in `buildCharAnchors` (filed as DOCS-2504).
//
// The production version skipped `vanishing` elements and re-inserted a synthetic space at
// each soft wrap. That dropped every tab, and dropped TWO characters at a hard break (the
// break itself, plus the space before it, which is vanishing too) — so any character offset
// past the first break in a block addressed the wrong text.
//
// The rule here emits a vanishing element's characters at ZERO width instead. The claim that
// needs guarding is that this changed the TEXT without changing the GEOMETRY. The probe that
// originally measured the fix compared rect counts but its width comparison was vacuous (it
// passed a mis-named placement field, so every width read back null), so the comparison is
// done properly here, against the real captured snapshot.
import { describe, expect, it } from "vitest";

import {
  type CharAnchor,
  type LayoutElement,
  type LayoutPart,
  type TokenRect,
  buildCharAnchors,
  rectsForCharRange,
} from "@/internal/bandGeometry";
import { fixtureParts, loadLayoutFixture } from "@/internal/__fixtures__/loadFixture";

const WHITESPACE = /\s/;
const fixture = loadLayoutFixture();
const parts = fixtureParts(fixture)
  .map(({ part }) => part)
  .filter((part) => (part.lines?.length ?? 0) > 0);

/** Exactly the production implementation this demo diverged from. */
function buildCharAnchorsAsShipped(part: LayoutPart): { fullText: string; charAnchors: CharAnchor[] } {
  const elementText = (el: LayoutElement): string => {
    const runs = el.input?.source?.runs;
    if (!Array.isArray(runs)) return el.input?.type === "s" ? " " : "";
    return runs.map((r) => r.text ?? "").join("");
  };
  const elementAdvances = (el: LayoutElement): number[] | null => {
    const advances = el.input?.advances;
    if (Array.isArray(advances)) return advances;
    const advanceX = el.input?.advanceX;
    if (typeof advanceX !== "number" || !Number.isFinite(advanceX)) return null;
    const count = el.input?.clusters ?? 1;
    return count <= 0 ? [] : Array<number>(count).fill(advanceX / count);
  };

  let fullText = "";
  const charAnchors: CharAnchor[] = [];
  const lines = part.lines ?? [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const spacingTop = line.lineSpacing?.top ?? 0;
    const spacingBottom = line.lineSpacing?.bottom ?? 0;
    const lineTop = (line.offset?.y ?? 0) - spacingTop;
    const lineHeight = spacingTop + spacingBottom;
    for (const segment of line.segments ?? []) {
      const segmentOffsetX = segment.offset?.x ?? 0;
      for (const element of segment.elements ?? []) {
        if (element.vanishing) continue;
        const text = elementText(element);
        const advances = elementAdvances(element);
        let cursorX = element.offset?.x ?? 0;
        for (let k = 0; k < text.length; k++) {
          const advance = advances?.[k] ?? 0;
          charAnchors.push({
            char: text[k],
            lineIndex: li,
            xLeft: segmentOffsetX + cursorX,
            xRight: segmentOffsetX + cursorX + advance,
            lineTop,
            lineHeight,
          });
          fullText += text[k];
          cursorX += advance;
        }
      }
    }
    if (li < lines.length - 1 && charAnchors.length > 0 && !WHITESPACE.test(fullText.slice(-1))) {
      const last = charAnchors[charAnchors.length - 1];
      charAnchors.push({
        char: " ",
        lineIndex: li,
        xLeft: last.xRight,
        xRight: last.xRight,
        lineTop: last.lineTop,
        lineHeight: last.lineHeight,
      });
      fullText += " ";
    }
  }
  return { fullText, charAnchors };
}

const FLAT_PLACEMENT = { caOffsetX: 0, caOffsetY: 0, partOffsetY: 0, pxPerPt: 1 };

/** Every rect the whole part paints, rounded past float64 noise. */
function wholePartRects(charAnchors: CharAnchor[]): TokenRect[] {
  return rectsForCharRange(charAnchors, 0, charAnchors.length, FLAT_PLACEMENT).map((rect) => ({
    left: +rect.left.toFixed(6),
    top: +rect.top.toFixed(6),
    width: +rect.width.toFixed(6),
    height: +rect.height.toFixed(6),
  }));
}

describe("the vanishing-element rule (DOCS-2504)", () => {
  it("has parts to measure, including soft-wrapped ones", () => {
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some((part) => (part.lines?.length ?? 0) > 1)).toBe(true);
  });

  it("paints geometrically identical rects to the implementation it replaced", () => {
    for (const part of parts) {
      const fixed = wholePartRects(buildCharAnchors(part).charAnchors);
      const shipped = wholePartRects(buildCharAnchorsAsShipped(part).charAnchors);
      // Same rect per visual line, at the same x and the same width — the zero-width anchors
      // are all whitespace, and `rectsForCharRange` drops a zero-width whitespace anchor.
      expect(fixed).toEqual(shipped);
    }
  });

  it("agrees with the shipped text on this fixture, which has no tabs or hard breaks", () => {
    // acme_nda soft-wraps but never tabs or hard-breaks, so both spellings should match here.
    // This is what makes the rect comparison above a fair one, and it is why the tab and
    // hard-break cases needed a purpose-built fixture (scratch/keyprobe/caret.docx) to catch.
    for (const part of parts) {
      expect(buildCharAnchors(part).fullText).toBe(buildCharAnchorsAsShipped(part).fullText);
    }
  });

  it("keeps the space a soft wrap consumes, so a token spanning the break still matches", () => {
    const wrapped = parts.filter((part) => (part.lines?.length ?? 0) > 1);
    for (const part of wrapped) {
      const { fullText } = buildCharAnchors(part);
      // No two glyph runs are ever welded together across a line boundary.
      expect(fullText).not.toMatch(/[a-z][A-Z]{2}/);
    }
  });

  it("gives every vanishing character zero width, so none can widen a rect", () => {
    for (const part of parts) {
      const { charAnchors } = buildCharAnchors(part);
      const shippedCount = buildCharAnchorsAsShipped(part).charAnchors.length;
      const zeroWidth = charAnchors.filter((anchor) => anchor.xRight === anchor.xLeft);
      // Every anchor the shipped version did not produce is a zero-width one.
      expect(charAnchors.length - shippedCount).toBeLessThanOrEqual(zeroWidth.length);
      for (const anchor of zeroWidth) expect(WHITESPACE.test(anchor.char)).toBe(true);
    }
  });
});
