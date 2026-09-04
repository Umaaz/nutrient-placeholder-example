// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 01 · property 2 — "carries a key we choose, and can be
//  enumerated".
//
//  This file IS the enumeration, done the hard way. There is no registry of placeholders to
//  ask, because a placeholder is not a thing the document holds — it is literal `{{ key }}`
//  text, indistinguishable from anything the user typed. So "list the fields" means walking
//  every block in the document and running a regex over its text.
//
//  `placeholders.all()` would delete this file. Everything below is a consequence of the
//  marker being text rather than a region:
//
//    · the list has to be rebuilt from scratch after any edit, because no event says which
//      region changed (ask 02 · C);
//    · a marker the user half-deleted still matches nothing and simply disappears from the
//      list, with no way to report that a field was damaged (ask 01 · property 1);
//    · block ordinals are the only address available, and they are body-global here while
//      the geometry walkers count per section — see the note on `BODY_GLOBAL_SECTION_INDEX`.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// Deliberately a MODEL scan, not a layout one. The SDK lays pages out only as the viewport
// approaches them, so a field further down the document has no text in the layout snapshot at
// all — the model walk is the only thing that can place it.
import type { DocAuthDocument } from "@nutrient-sdk/document-authoring";

import type { BlockRef } from "@/internal/bandGeometry";
import { trace } from "@/internal/trace";

/** Structural slice of the SDK's text view — only what this module needs. */
type DocAuthTextView = { getPlainText: () => string };

type DraftBlock = {
  type: string;
  asTextView: () => DocAuthTextView;
  /** Present on a table block. Its cells nest whole block lists, including further tables. */
  rows?: () => DraftRow[];
};

type DraftRow = { cells: () => { blocklevels: () => DraftBlock[] }[] };

type DraftLike = { body: () => { content: () => { blocklevels: () => DraftBlock[] } } };

/**
 * SDK 1.15 moved block content off `Section` onto a single body-global `body.content()`,
 * leaving sections as page-setup metadata — so a block ordinal is body-global and there is no
 * per-section numbering left to be relative to. `Paragraph.findSection()` cannot rebuild one
 * either: it hands back a fresh wrapper each call, so the section it names cannot be identified.
 *
 * `BlockRef` still carries a section, so every ref is stamped with the only ordinal that is now
 * meaningful. This is exact for a single-section document. For a MULTI-SECTION one it disagrees
 * with the per-section counting in `resolveBlockAtPoint`, and fields after a section break
 * resolve to the wrong block — visible in this demo by loading `multi-section-nda.docx`. The
 * disagreement exists because a block's identity has to be reconstructed from ordinals at all.
 */
const BODY_GLOBAL_SECTION_INDEX = 0;

/** `{{ key }}` — the marker spelling this demo writes and reads. */
const MARKER_RE = /\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}/g;

/** The literal marker text for a key, in the spelling `writeMarkerOverText` writes. */
export function markerFor(key: string): string {
  return `{{ ${key} }}`;
}

/** One placeholder found in the document text. */
export type ScannedField = {
  key: string;
  /** The marker exactly as it appears, which may be respaced (`{{key}}`) by an edit. */
  marker: string;
  /** Every block whose text carries this key's marker, in document order. */
  blocks: BlockRef[];
  /** Total marker occurrences across those blocks. */
  occurrences: number;
};

/**
 * Every `{{ key }}` marker in the document, with the blocks that carry it.
 *
 * Read-only: the transaction is closed with `commit: false`, so nothing is written and no
 * tracked-change revision is created. One pass over the document, not one per key.
 */
export async function scanMarkers(doc: DocAuthDocument): Promise<ScannedField[]> {
  trace({
    capability: "scan",
    reach: "public-misuse",
    touched: "doc.transaction({ commit: false }) → body().content().blocklevels() → regex over getPlainText()",
    because:
      "A placeholder is literal text, so there is nothing to enumerate. Listing the fields means opening a transaction purely to read, walking every block, and regexing its plain text.",
    ask: "01 · 2",
  });

  return doc.transaction<ScannedField[]>(async ({ draft }) => {
    const byKey = new Map<string, ScannedField>();
    const blocks = (draft as unknown as DraftLike).body().content().blocklevels();

    const record = (key: string, marker: string, ref: BlockRef) => {
      const found = byKey.get(key);
      if (!found) {
        byKey.set(key, { key, marker, blocks: [ref], occurrences: 1 });
        return;
      }
      found.occurrences++;
      const last = found.blocks[found.blocks.length - 1];
      // One block can hold the same marker twice; the ref addresses the block, so do not
      // repeat it. The occurrence COUNT is what tells the two apart.
      if (last.blockIndex !== ref.blockIndex || last.rowIndex !== ref.rowIndex) found.blocks.push(ref);
    };

    const testParagraph = (block: DraftBlock, blockIndex: number, rowIndex: number | null) => {
      let text: string;
      try {
        text = block.asTextView().getPlainText();
      } catch {
        return;
      }
      MARKER_RE.lastIndex = 0;
      for (let hit = MARKER_RE.exec(text); hit !== null; hit = MARKER_RE.exec(text)) {
        record(
          hit[1],
          hit[0],
          // Only a table match carries a row: a paragraph ref stays the two-field shape.
          rowIndex === null
            ? { sectionIndex: BODY_GLOBAL_SECTION_INDEX, blockIndex }
            : { sectionIndex: BODY_GLOBAL_SECTION_INDEX, blockIndex, rowIndex },
        );
      }
    };

    // Descends into tables, because a cell's paragraphs are NOT top-level blocks: a signature
    // block is usually a table, and skipping them means those fields match nothing at all —
    // no band and no diagnostic, since a field with no block never reaches the painter.
    // Nested tables report their OUTERMOST row, which is the one whose geometry the painter
    // could resolve — if it descended into tables at all, which it does not.
    const walk = (block: DraftBlock, blockIndex: number, rowIndex: number | null) => {
      if (block.type === "paragraph") {
        testParagraph(block, blockIndex, rowIndex);
        return;
      }
      if (typeof block.rows !== "function") return;
      const rows = block.rows();
      for (let ri = 0; ri < rows.length; ri++) {
        for (const cell of rows[ri].cells()) {
          for (const cellBlock of cell.blocklevels()) {
            walk(cellBlock, blockIndex, rowIndex ?? ri);
          }
        }
      }
    };

    // `blockIndex` is the position in `blocklevels()`, so a table still occupies an ordinal
    // even though its text lives in cells.
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      walk(blocks[blockIndex], blockIndex, null);
    }

    return { commit: false, result: [...byKey.values()] };
  });
}
