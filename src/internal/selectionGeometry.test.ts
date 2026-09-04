import { describe, expect, it } from "vitest";

import {
  fixtureDocumentContext,
  fixturePartForBlock,
  fixturePlacementForBlock,
  loadLayoutFixture,
} from "@/internal/__fixtures__/loadFixture";
import { buildCharAnchors } from "@/internal/bandGeometry";
import {
  type OverlayRect,
  deriveTextSelection,
  pointToCharIndex,
  resolveBlockAtPoint,
  selectionAnchorPlacement,
  snapToWordBoundaries,
} from "@/internal/selectionGeometry";

const fixture = loadLayoutFixture();
const documentContext = fixtureDocumentContext(fixture.body);

// Blocks of the trimmed real NDA capture (see __fixtures__/README.md).
const TITLE_BLOCK = 0; // "MUTUAL NON-DISCLOSURE AGREEMENT" — page 0
const PLACEHOLDERS_BLOCK = 3; // "[name of the Company], a [type of company], ..." — page 0, 2 lines
const HEADING_BLOCK = 4; // "1. Affiliates; Confidential Information" — page 0
const BODY_BLOCK = 6; // page 1, 3 lines

const PAGE_WIDTH_PX = fixture.pageDivWidths[0];

/** The page-local px point at the centre of a block's `charIndex`-th character. */
function charCenterPx(blockIndex: number, charIndex: number): { x: number; y: number } {
  const placement = fixturePlacementForBlock(fixture, blockIndex);
  const { charAnchors } = buildCharAnchors(fixturePartForBlock(fixture, blockIndex));
  const anchor = charAnchors[charIndex];
  return {
    x: (placement.caOffsetX + (anchor.xLeft + anchor.xRight) / 2) * placement.pxPerPt,
    y: (placement.caOffsetY + placement.partOffsetY + anchor.lineTop + anchor.lineHeight / 2) * placement.pxPerPt,
  };
}

const blockText = (blockIndex: number) => buildCharAnchors(fixturePartForBlock(fixture, blockIndex)).fullText;

describe("resolveBlockAtPoint", () => {
  it("resolves the block whose glyph band contains the point", () => {
    const resolved = resolveBlockAtPoint(documentContext, 0, charCenterPx(PLACEHOLDERS_BLOCK, 1), PAGE_WIDTH_PX);

    expect(resolved?.blockRef).toEqual({ sectionIndex: 0, blockIndex: PLACEHOLDERS_BLOCK });
  });

  it("numbers blocks continuously across pages, so a point on page two resolves correctly", () => {
    const resolved = resolveBlockAtPoint(documentContext, 1, charCenterPx(BODY_BLOCK, 1), PAGE_WIDTH_PX);

    expect(resolved?.blockRef).toEqual({ sectionIndex: 0, blockIndex: BODY_BLOCK });
  });

  it("resolves the nearest block for a point in the side margin, where there are no glyphs", () => {
    const { y } = charCenterPx(TITLE_BLOCK, 0);

    const resolved = resolveBlockAtPoint(documentContext, 0, { x: 4, y }, PAGE_WIDTH_PX);

    expect(resolved?.blockRef).toEqual({ sectionIndex: 0, blockIndex: TITLE_BLOCK });
  });

  it("returns null in the empty band between two distant blocks", () => {
    const above = charCenterPx(PLACEHOLDERS_BLOCK, 0).y;
    const below = charCenterPx(HEADING_BLOCK, 0).y;

    const resolved = resolveBlockAtPoint(documentContext, 0, { x: 200, y: (above + below) / 2 }, PAGE_WIDTH_PX);

    expect(resolved).toBeNull();
  });

  it("returns null for a page the snapshot has not laid out", () => {
    expect(resolveBlockAtPoint(documentContext, 99, { x: 200, y: 300 }, PAGE_WIDTH_PX)).toBeNull();
  });
});

describe("pointToCharIndex", () => {
  const { charAnchors } = buildCharAnchors(fixturePartForBlock(fixture, PLACEHOLDERS_BLOCK));

  it("returns the caret index of the character under the point", () => {
    const anchor = charAnchors[6];

    const index = pointToCharIndex(
      charAnchors,
      anchor.xLeft + (anchor.xRight - anchor.xLeft) * 0.2,
      anchor.lineTop + 1,
    );

    expect(index).toBe(6);
  });

  it("returns the caret at the end of the line when the point is past its trailing edge", () => {
    const firstOnSecondLine = charAnchors.findIndex((anchor) => anchor.lineIndex === 1);

    const index = pointToCharIndex(charAnchors, 10_000, charAnchors[0].lineTop + 1);

    expect(index).toBe(firstOnSecondLine - 1);
  });

  it("picks the vertically nearest line when the point falls in the gap between two lines", () => {
    const firstOnSecondLine = charAnchors.findIndex((anchor) => anchor.lineIndex === 1);
    const justAboveSecondLine = charAnchors[firstOnSecondLine].lineTop - 0.5;

    const index = pointToCharIndex(charAnchors, charAnchors[0].xLeft, justAboveSecondLine);

    expect(index).toBe(firstOnSecondLine);
  });

  it("returns 0 for a part with no anchors rather than throwing", () => {
    expect(pointToCharIndex([], 100, 100)).toBe(0);
  });
});

describe("snapToWordBoundaries", () => {
  it("expands a partial range out to whole words", () => {
    expect(snapToWordBoundaries("the quick brown fox", 5, 12)).toEqual({ start: 4, end: 15 });
  });

  it("normalises a right-to-left drag to the same range as its mirror", () => {
    expect(snapToWordBoundaries("the quick brown fox", 12, 5)).toEqual(
      snapToWordBoundaries("the quick brown fox", 5, 12),
    );
  });

  it("trims leading whitespace the expansion could not swallow", () => {
    expect(snapToWordBoundaries("  fox", 0, 2)).toEqual({ start: 2, end: 5 });
  });

  it("collapses when there is no word to snap to", () => {
    const { start, end } = snapToWordBoundaries("   ", 0, 3);

    expect(end - start).toBe(0);
  });
});

describe("deriveTextSelection", () => {
  const derive = (blockIndex: number, pageIndex: number, fromChar: number, toChar: number) =>
    deriveTextSelection({
      documentContext,
      pageIndex,
      pageDivWidthPx: PAGE_WIDTH_PX,
      from: charCenterPx(blockIndex, fromChar),
      to: charCenterPx(blockIndex, toChar),
    });

  it("derives the word-snapped text a drag covered, from pointer coordinates alone", () => {
    const selection = derive(PLACEHOLDERS_BLOCK, 0, 1, 6);

    expect(selection?.text).toBe("[name of");
    expect(selection?.blockRef).toEqual({ sectionIndex: 0, blockIndex: PLACEHOLDERS_BLOCK });
    expect(selection?.blockText).toBe(blockText(PLACEHOLDERS_BLOCK));
    expect(blockText(PLACEHOLDERS_BLOCK).slice(selection?.charStart, selection?.charEnd)).toBe(selection?.text);
  });

  it("reports the page the selection sits on", () => {
    expect(derive(BODY_BLOCK, 1, 4, 10)?.pageIndex).toBe(1);
  });

  it("emits one rect per visual line the selection spans", () => {
    const wrapped = derive(PLACEHOLDERS_BLOCK, 0, 1, 100);
    const singleLine = derive(PLACEHOLDERS_BLOCK, 0, 1, 6);

    expect(wrapped?.rects).toHaveLength(2);
    expect(singleLine?.rects).toHaveLength(1);
  });

  it("refuses a collapsed point, so a click never snaps out to the word under it", () => {
    const point = charCenterPx(PLACEHOLDERS_BLOCK, 40);

    const selection = deriveTextSelection({
      documentContext,
      pageIndex: 0,
      pageDivWidthPx: PAGE_WIDTH_PX,
      from: point,
      to: point,
    });

    expect(selection).toBeNull();
  });

  it("refuses a drag spanning two blocks rather than truncating it to the first", () => {
    const selection = deriveTextSelection({
      documentContext,
      pageIndex: 0,
      pageDivWidthPx: PAGE_WIDTH_PX,
      from: charCenterPx(PLACEHOLDERS_BLOCK, 1),
      to: charCenterPx(HEADING_BLOCK, 1),
    });

    expect(selection).toBeNull();
  });

  it("refuses a drag that starts over no block at all", () => {
    const selection = deriveTextSelection({
      documentContext,
      pageIndex: 0,
      pageDivWidthPx: PAGE_WIDTH_PX,
      from: { x: 200, y: 0 },
      to: charCenterPx(PLACEHOLDERS_BLOCK, 6),
    });

    expect(selection).toBeNull();
  });

  it("refuses a drag that ends over no block at all", () => {
    const selection = deriveTextSelection({
      documentContext,
      pageIndex: 0,
      pageDivWidthPx: PAGE_WIDTH_PX,
      from: charCenterPx(PLACEHOLDERS_BLOCK, 1),
      to: { x: 200, y: 0 },
    });

    expect(selection).toBeNull();
  });
});

describe("selectionAnchorPlacement", () => {
  const OVERLAY = { width: 1000, height: 600 };
  const CARD = { width: 320, height: 44 };
  const rect = (overrides: Partial<OverlayRect> = {}): OverlayRect => ({
    top: 200,
    left: 400,
    width: 120,
    height: 14,
    ...overrides,
  });

  it("hangs the card below the selection when there is room", () => {
    expect(selectionAnchorPlacement(rect(), OVERLAY, CARD).placement).toBe("below");
  });

  it("flips above when the card would overflow the bottom", () => {
    expect(selectionAnchorPlacement(rect({ top: 580 }), OVERLAY, CARD).placement).toBe("above");
  });

  it("stays below when neither side has room, rather than clipping off the top", () => {
    expect(
      selectionAnchorPlacement(rect({ top: 580 }), { width: 1000, height: 600 }, { width: 320, height: 640 }).placement,
    ).toBe("below");
  });

  it("centres the card on the selection when it fits", () => {
    const { rect: anchored } = selectionAnchorPlacement(rect(), OVERLAY, CARD);

    expect(anchored.left).toBe(460);
    expect(anchored.width).toBe(0);
  });

  it("clamps the card inside the overlay's leading and trailing edges", () => {
    const nearStart = selectionAnchorPlacement(rect({ left: 0, width: 20 }), OVERLAY, CARD);
    const nearEnd = selectionAnchorPlacement(rect({ left: 980, width: 20 }), OVERLAY, CARD);

    expect(nearStart.rect.left).toBe(168);
    expect(nearEnd.rect.left).toBe(832);
  });

  it("pins the card to the top edge when the selection has scrolled out above", () => {
    const { rect: anchored, placement } = selectionAnchorPlacement(rect({ top: -400 }), OVERLAY, CARD);

    expect(anchored.top).toBe(0);
    expect(placement).toBe("below");
  });

  it("pins the card to the bottom edge when the selection has scrolled out below", () => {
    const { rect: anchored, placement } = selectionAnchorPlacement(rect({ top: 900 }), OVERLAY, CARD);

    expect(anchored.top).toBe(600);
    expect(placement).toBe("above");
  });
});
