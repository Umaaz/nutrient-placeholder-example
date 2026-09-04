import { describe, expect, it } from "vitest";

import {
  fixtureParts,
  fixturePartForBlock,
  fixturePlacementForBlock,
  loadLayoutFixture,
} from "@/internal/__fixtures__/loadFixture";
import {
  type LayoutPart,
  buildCharAnchors,
  computeTokenRectsForPart,
  rectsForCharRange,
} from "@/internal/bandGeometry";

const fixture = loadLayoutFixture();

// Blocks of the trimmed real NDA capture (see __fixtures__/README.md).
const TITLE_BLOCK = 0; // "MUTUAL NON-DISCLOSURE AGREEMENT" — larger heading font
const DEFINED_TERMS_BLOCK = 1; // ...(the "Agreement")... (the "Effective Date")...
const PLACEHOLDERS_BLOCK = 3; // "[name of the Company], a [type of company], ..."
const HEADING_BLOCK = 4; // "1. Affiliates; Confidential Information"
const WRAPPED_BLOCK = 5; // one Confidential Information straddling a soft wrap
const BODY_BLOCK = 6; // "All Confidential Information shall remain..."
const PROSE_TERM_BLOCK = 7; // "...as of the Effective Date." — unquoted
const TABLE_BLOCK = 8; // a table part: carries rows, no lines

const placementFor = (blockIndex: number) => {
  const { caOffsetX, caOffsetY, partOffsetY, pxPerPt } = fixturePlacementForBlock(fixture, blockIndex);
  return { caOffsetX, caOffsetY, partOffsetY, pxPerPt };
};

const rectsFor = (blockIndex: number, token: string) =>
  computeTokenRectsForPart(fixturePartForBlock(fixture, blockIndex), token, placementFor(blockIndex));

// Rects are compared at the 0.1px the reference implementation printed.
const closeTo = (rect: { left: number; top: number; width: number; height: number }) => ({
  left: expect.closeTo(rect.left, 1),
  top: expect.closeTo(rect.top, 1),
  width: expect.closeTo(rect.width, 1),
  height: expect.closeTo(rect.height, 1),
});

describe("buildCharAnchors", () => {
  it("takes the glyph-cell top from the baseline, not from line.offset.y itself", () => {
    const part = fixturePartForBlock(fixture, TITLE_BLOCK);
    const line = part.lines?.[0];
    const spacingTop = line?.lineSpacing?.top ?? 0;
    const spacingBottom = line?.lineSpacing?.bottom ?? 0;

    const { charAnchors } = buildCharAnchors(part);

    expect(charAnchors[0].lineTop).toBeCloseTo((line?.offset?.y ?? 0) - spacingTop, 6);
    expect(charAnchors[0].lineHeight).toBeCloseTo(spacingTop + spacingBottom, 6);
  });

  it("paints the tight glyph cell, which is shorter than the line-advance box", () => {
    const part = fixturePartForBlock(fixture, TITLE_BLOCK);
    const line = part.lines?.[0];

    const { charAnchors } = buildCharAnchors(part);

    // line.extent.y IS a height — the full line advance — just not the one to paint.
    expect(line?.extent?.y).toBeGreaterThan(charAnchors[0].lineHeight);
  });

  it("re-inserts the space a soft wrap dropped, as a zero-width anchor", () => {
    const part = fixturePartForBlock(fixture, WRAPPED_BLOCK);

    const { fullText, charAnchors } = buildCharAnchors(part);

    // Without the synthetic space the raw concatenation reads "ConfidentialInformation".
    expect(fullText).toContain("Confidential Information");
    const wrapAnchors = charAnchors.filter(
      (anchor, i) => anchor.char === " " && charAnchors[i + 1]?.lineIndex === anchor.lineIndex + 1,
    );
    expect(wrapAnchors.length).toBeGreaterThan(0);
    for (const anchor of wrapAnchors) expect(anchor.xRight).toBe(anchor.xLeft);
  });

  it("advances each character by its own glyph width", () => {
    const { charAnchors } = buildCharAnchors(fixturePartForBlock(fixture, TITLE_BLOCK));

    const widths = charAnchors.filter((a) => a.char !== " ").map((a) => a.xRight - a.xLeft);
    expect(widths.every((w) => w > 0)).toBe(true);
    // Proportional font: an "M" is wider than an "I".
    const mWidth = charAnchors.find((a) => a.char === "M")!;
    const iWidth = charAnchors.find((a) => a.char === "I")!;
    expect(mWidth.xRight - mWidth.xLeft).toBeGreaterThan(iWidth.xRight - iWidth.xLeft);
  });

  it("finds every laid-out part of the real document measurable", () => {
    const laidOut = fixtureParts(fixture).filter(({ part }) => (part.lines?.length ?? 0) > 0);

    expect(laidOut.length).toBeGreaterThan(0);
    for (const { part } of laidOut) expect(buildCharAnchors(part).measurable).toBe(true);
  });

  it("yields nothing for a part that carries no lines", () => {
    const { fullText, charAnchors } = buildCharAnchors(fixturePartForBlock(fixture, TABLE_BLOCK));

    expect(fullText).toBe("");
    expect(charAnchors).toEqual([]);
  });
});

describe("computeTokenRectsForPart", () => {
  it("resolves a single-line token to one rect, where the reference implementation painted it", () => {
    const { rects, occurrences } = rectsFor(PLACEHOLDERS_BLOCK, "[name of the Company]");

    expect(occurrences).toBe(1);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual(closeTo({ left: 120, top: 249.3, width: 138.6, height: 14.9 }));
  });

  it("counts a soft-wrapped match as one occurrence spread over several rects", () => {
    const { rects, occurrences, occurrenceRects } = rectsFor(WRAPPED_BLOCK, "Confidential Information");

    expect(occurrences).toBe(1);
    expect(rects).toHaveLength(2);
    expect(occurrenceRects[0]).toHaveLength(2);
    expect(rects[0]).toEqual(closeTo({ left: 602.5, top: 168, width: 70.4, height: 14.9 }));
    expect(rects[1]).toEqual(closeTo({ left: 120, top: 185.6, width: 66.7, height: 14.9 }));
  });

  it("groups rects per distinct occurrence rather than reporting one per line", () => {
    const { occurrences, occurrenceRects, rects } = rectsFor(BODY_BLOCK, "Confidential Information");

    expect(occurrences).toBe(2);
    expect(occurrenceRects.map((group) => group.length)).toEqual([1, 2]);
    expect(rects).toHaveLength(3);
  });

  it("gives a heading token a taller rect than the same token in body text", () => {
    const heading = rectsFor(HEADING_BLOCK, "Confidential Information");
    const body = rectsFor(BODY_BLOCK, "Confidential Information");

    expect(heading.rects[0].height).toBeGreaterThan(body.rects[0].height);
    expect(heading.rects[0].width).toBeGreaterThan(body.rects[0].width);
  });

  it("matches case-sensitively, so a field label cannot paint over lowercase prose", () => {
    expect(rectsFor(HEADING_BLOCK, "confidential information").occurrences).toBe(0);
    expect(rectsFor(BODY_BLOCK, "CONFIDENTIAL INFORMATION").rects).toEqual([]);
    expect(rectsFor(BODY_BLOCK, "Confidential Information").occurrences).toBeGreaterThan(0);
  });

  it("matches across respacing, since it compares non-whitespace skeletons", () => {
    const spaced = rectsFor(PLACEHOLDERS_BLOCK, "[name of  the\tCompany]");
    const exact = rectsFor(PLACEHOLDERS_BLOCK, "[name of the Company]");

    expect(spaced.rects).toEqual(exact.rects);
  });

  it("skips a quoted defined term but still matches the same words unquoted", () => {
    // The term appears only as ("Effective Date") in this block — a field's NAME, not a site.
    expect(rectsFor(DEFINED_TERMS_BLOCK, "Effective Date").occurrences).toBe(0);
    expect(rectsFor(PROSE_TERM_BLOCK, "Effective Date").occurrences).toBe(1);
  });

  it("skips only the quoted instance when a block holds both", () => {
    // Block 1 carries `Non-Disclosure Agreement` (a site) and ("Agreement") (a name).
    const { occurrences } = rectsFor(DEFINED_TERMS_BLOCK, "Agreement");

    expect(occurrences).toBe(1);
  });

  it("emits nothing for a token that is absent, rather than a page-wide rect", () => {
    const { rects, occurrences } = rectsFor(BODY_BLOCK, "Arbitration Venue");

    expect(rects).toEqual([]);
    expect(occurrences).toBe(0);
  });

  // Both produce no band, but only one is a resolution failure worth a diagnostic.
  it("separates a by-design exclusion from a token that simply is not there", () => {
    expect(rectsFor(DEFINED_TERMS_BLOCK, "Effective Date").excludedByQuotes).toBe(1);
    expect(rectsFor(BODY_BLOCK, "Arbitration Venue").excludedByQuotes).toBe(0);
    expect(rectsFor(DEFINED_TERMS_BLOCK, "Agreement").excludedByQuotes).toBe(1);
  });

  it("emits nothing for a whitespace-only token", () => {
    expect(rectsFor(BODY_BLOCK, "   ").rects).toEqual([]);
  });
});

describe("shape drift tolerance", () => {
  it("emits nothing for a part whose lines are missing", () => {
    const part = fixturePartForBlock(fixture, BODY_BLOCK);
    const drifted: LayoutPart = { ...part, lines: undefined };

    expect(() => computeTokenRectsForPart(drifted, "Confidential Information", placementFor(BODY_BLOCK))).not.toThrow();
    expect(computeTokenRectsForPart(drifted, "Confidential Information", placementFor(BODY_BLOCK)).rects).toEqual([]);
  });

  it("emits nothing when elements carry no advance widths", () => {
    const real = fixturePartForBlock(fixture, BODY_BLOCK);
    const stripped: LayoutPart = {
      ...real,
      lines: real.lines?.map((line) => ({
        ...line,
        segments: line.segments?.map((segment) => ({
          ...segment,
          elements: segment.elements?.map((element) => ({
            ...element,
            input: { type: element.input?.type, source: element.input?.source },
          })),
        })),
      })),
    };

    const { rects } = computeTokenRectsForPart(stripped, "Confidential Information", placementFor(BODY_BLOCK));

    // The text still matches; with no widths there is no honest rect to paint.
    expect(buildCharAnchors(stripped).fullText).toContain("Confidential Information");
    expect(rects).toEqual([]);
  });

  it("emits nothing for a content area whose segments are missing", () => {
    const real = fixturePartForBlock(fixture, BODY_BLOCK);
    const drifted: LayoutPart = { ...real, lines: real.lines?.map((line) => ({ ...line, segments: undefined })) };

    expect(computeTokenRectsForPart(drifted, "Confidential Information", placementFor(BODY_BLOCK)).rects).toEqual([]);
  });
});

describe("rectsForCharRange", () => {
  it("ignores a range that starts beyond the anchors", () => {
    const { charAnchors } = buildCharAnchors(fixturePartForBlock(fixture, TITLE_BLOCK));

    expect(rectsForCharRange(charAnchors, 9000, 9010, placementFor(TITLE_BLOCK))).toEqual([]);
  });

  it("covers a range spanning two lines with one rect per line", () => {
    const part = fixturePartForBlock(fixture, WRAPPED_BLOCK);
    const { charAnchors } = buildCharAnchors(part);
    const firstOnSecondLine = charAnchors.findIndex((anchor) => anchor.lineIndex === 1);

    const rects = rectsForCharRange(
      charAnchors,
      firstOnSecondLine - 4,
      firstOnSecondLine + 4,
      placementFor(WRAPPED_BLOCK),
    );

    expect(rects).toHaveLength(2);
  });
});

describe("the layout tree's advance chain", () => {
  // Sharper than any single coordinate: it pins the horizontal units and the per-glyph advance
  // model together, so a units change or a rewritten advance model fails here, not just a rename.
  it("has each element starting exactly where the previous one's advances end", () => {
    // Per-glyph widths when present; a space element carries only its total advance.
    const advanceOf = (element: { input?: { advances?: number[]; advanceX?: number } }) =>
      element.input?.advances?.reduce((total, advance) => total + advance, 0) ?? element.input?.advanceX ?? 0;

    let pairs = 0;
    for (const { part } of fixtureParts(fixture)) {
      for (const line of part.lines ?? []) {
        for (const segment of line.segments ?? []) {
          const elements = segment.elements ?? [];
          for (let i = 0; i < elements.length - 1; i++) {
            const current = elements[i];
            const next = elements[i + 1];
            // A vanishing element (e.g. a consumed soft-wrap break) carries no advance and so
            // does not participate in the chain.
            if (current.vanishing || next.vanishing) continue;
            expect((current.offset?.x ?? 0) + advanceOf(current)).toBeCloseTo(next.offset?.x ?? 0, 3);
            pairs++;
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(300);
  });
});
