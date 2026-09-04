import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LayoutPart } from "@/internal/bandGeometry";
import type { LayoutSection } from "@/internal/snapshotLayout";

export type LayoutFixture = {
  sdkVersion: string;
  pageDivWidths: number[];
  body: LayoutSection[];
};

// Read at runtime rather than `import ... from "*.json"`: a static import makes tsc infer a
// literal type for the whole 75KB tree, which is slow and buys nothing.
export function loadLayoutFixture(): LayoutFixture {
  const path = join(dirname(fileURLToPath(import.meta.url)), "ndaLayoutSnapshot.json");
  return JSON.parse(readFileSync(path, "utf8")) as LayoutFixture;
}

/** The fixture's laid-out parts in traversal order, tagged with the page they sit on. */
export function fixtureParts(fixture: LayoutFixture): { pageIndex: number; part: LayoutPart }[] {
  const parts: { pageIndex: number; part: LayoutPart }[] = [];
  let pageIndex = 0;
  for (const section of fixture.body) {
    for (const page of section.pages ?? []) {
      for (const ca of page.contentAreas ?? []) {
        for (const part of ca.bodyParts ?? []) parts.push({ pageIndex, part });
      }
      pageIndex++;
    }
  }
  return parts;
}

/**
 * The block index each fixture part belongs to, under the same `partIdx === 0` counting the
 * walkers use, so tests address blocks the way production callers do.
 */
export function fixtureBlockIndexes(fixture: LayoutFixture): number[] {
  let block = -1;
  return fixtureParts(fixture).map(({ part }) => {
    if (part.partIdx === 0) block++;
    return block;
  });
}

export function fixturePartForBlock(fixture: LayoutFixture, blockIndex: number): LayoutPart {
  const blocks = fixtureBlockIndexes(fixture);
  const index = blocks.indexOf(blockIndex);
  if (index < 0) throw new Error(`Fixture has no block ${blockIndex}`);
  return fixtureParts(fixture)[index].part;
}

/** The content area holding `blockIndex`, needed for its offsets and pt→px scale. */
export function fixturePlacementForBlock(
  fixture: LayoutFixture,
  blockIndex: number,
): { caOffsetX: number; caOffsetY: number; partOffsetY: number; pxPerPt: number; pageIndex: number } {
  const blocks = fixtureBlockIndexes(fixture);
  let flat = -1;
  let pageIndex = 0;
  for (const section of fixture.body) {
    for (const page of section.pages ?? []) {
      for (const ca of page.contentAreas ?? []) {
        for (const part of ca.bodyParts ?? []) {
          flat++;
          if (blocks[flat] !== blockIndex) continue;
          const caOffsetX = ca.offset?.x ?? 0;
          const caOffsetY = ca.offset?.y ?? 0;
          const pageWidthPt = caOffsetX * 2 + (ca.extent?.x ?? 0);
          return {
            caOffsetX,
            caOffsetY,
            partOffsetY: part.offset?.y ?? 0,
            pxPerPt: fixture.pageDivWidths[pageIndex] / pageWidthPt,
            pageIndex,
          };
        }
      }
      pageIndex++;
    }
  }
  throw new Error(`Fixture has no block ${blockIndex}`);
}

/** A `documentContext` stand-in serving the fixture's layout tree. */
export function fixtureDocumentContext(body: LayoutSection[]): {
  shadowState: { snapshot: () => { shadow: { body: LayoutSection[] } } };
} {
  return { shadowState: { snapshot: () => ({ shadow: { body } }) } };
}
