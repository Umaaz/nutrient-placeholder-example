// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 02 · B — "A way to point at a span of the text you gave us…
//  including when the same phrase occurs several times in one paragraph and only one of them
//  is the field".
//
//  This file is what that sentence costs. To offer the author "make the 1st and the 3rd
//  'Acme Analytics' into a field", we first have to know that there ARE occurrences, where
//  they are, and in what order — and `searchText` reports none of that. It hands back an
//  opaque range and nothing else: no offset, no ordinal, no count, and no way to ask "which
//  number is this one".
//
//  So occurrences are enumerated the only way available: walk every block, read its plain
//  text, and index the string ourselves. That yields an ordinal — but an ordinal is a
//  position in a snapshot of text, NOT an identity. See `OccurrenceOrdinalWarning` below for
//  why that distinction is the whole point of the ask.
// ─────────────────────────────────────────────────────────────────────────────────────────
import type { DocAuthDocument } from "@nutrient-sdk/document-authoring";

import type { BlockRef } from "@/internal/bandGeometry";
import { trace } from "@/internal/trace";

/** Structural slice of the SDK's text view — only what this module needs. */
type DocAuthTextView = { getPlainText: () => string };

type DraftBlock = {
  type: string;
  asTextView: () => DocAuthTextView;
  rows?: () => DraftRow[];
};

type DraftRow = { cells: () => { blocklevels: () => DraftBlock[] }[] };

type DraftLike = { body: () => { content: () => { blocklevels: () => DraftBlock[] } } };

/** Same body-global numbering as `scanMarkers` — see the note there. */
const BODY_GLOBAL_SECTION_INDEX = 0;

/** How much text either side of an occurrence to keep, so the author can tell them apart. */
const CONTEXT_CHARS = 44;

/** One occurrence of a phrase in the document. */
export type Occurrence = {
  /**
   * 0-based position in document order across the whole document.
   *
   * NOT an identity. It is this occurrence's index in the text as it reads right now. Any edit
   * that adds or removes an earlier occurrence renumbers every one after it, silently, and
   * nothing in the public API can tell a caller that happened.
   */
  ordinal: number;
  /** 0-based position among the occurrences within this block alone. */
  ordinalInBlock: number;
  blockRef: BlockRef;
  /** The block's plain text, as the MODEL spells it. */
  blockText: string;
  charStart: number;
  charEnd: number;
  /** `blockText` around the occurrence, for a disambiguating label. */
  contextBefore: string;
  contextAfter: string;
  /** True when the occurrence is the one the user's own selection covers. */
  isSelection: boolean;
};

export type FindOccurrencesParams = {
  doc: DocAuthDocument;
  /** The phrase to find. Matched literally and case-sensitively. */
  phrase: string;
  /**
   * The occurrence the user actually selected, so it can be flagged in the list. Matched on
   * (blockIndex, charStart); a null means no occurrence is flagged.
   */
  selection?: { blockRef: BlockRef; charStart: number } | null;
  /** Restrict to one block — "several times in one paragraph". */
  withinBlock?: BlockRef | null;
};

/**
 * Every occurrence of `phrase`, in document order.
 *
 * Read-only: the transaction closes with `commit: false`, so nothing is written and no
 * tracked-change revision is created.
 *
 * A whole extra document walk, for a question `searchText` is already answering internally
 * and declining to report. `find` (added in 1.19.0) is the namespace this belongs on.
 */
export async function findOccurrences({
  doc,
  phrase,
  selection = null,
  withinBlock = null,
}: FindOccurrencesParams): Promise<Occurrence[]> {
  if (phrase.length === 0) return [];

  trace({
    capability: "occurrences",
    reach: "public-misuse",
    touched: "a second full document walk + String.indexOf, because searchText reports no offset, ordinal or count",
    because:
      "searchText hands back an opaque range and nothing else. To offer the author a choice between repeated occurrences, they have to be enumerated and indexed by hand — and the resulting ordinals are positions in a snapshot, not identities.",
    ask: "02 · B",
  });

  return doc.transaction<Occurrence[]>(async ({ draft }) => {
    const occurrences: Occurrence[] = [];
    const blocks = (draft as unknown as DraftLike).body().content().blocklevels();
    let ordinal = 0;

    const collect = (block: DraftBlock, blockIndex: number, rowIndex: number | null) => {
      if (withinBlock && (withinBlock.blockIndex !== blockIndex || (withinBlock.rowIndex ?? null) !== rowIndex)) {
        return;
      }
      let blockText: string;
      try {
        blockText = block.asTextView().getPlainText();
      } catch {
        return;
      }

      let ordinalInBlock = 0;
      for (let at = blockText.indexOf(phrase); at !== -1; at = blockText.indexOf(phrase, at + phrase.length)) {
        const blockRef: BlockRef =
          rowIndex === null
            ? { sectionIndex: BODY_GLOBAL_SECTION_INDEX, blockIndex }
            : { sectionIndex: BODY_GLOBAL_SECTION_INDEX, blockIndex, rowIndex };
        occurrences.push({
          ordinal: ordinal++,
          ordinalInBlock: ordinalInBlock++,
          blockRef,
          blockText,
          charStart: at,
          charEnd: at + phrase.length,
          contextBefore: blockText.slice(Math.max(0, at - CONTEXT_CHARS), at),
          contextAfter: blockText.slice(at + phrase.length, at + phrase.length + CONTEXT_CHARS),
          isSelection:
            selection !== null &&
            selection.blockRef.blockIndex === blockIndex &&
            (selection.blockRef.rowIndex ?? null) === rowIndex &&
            selection.charStart === at,
        });
      }
    };

    // Same table descent as `scanMarkers`: a cell's paragraphs are not top-level blocks.
    const walk = (block: DraftBlock, blockIndex: number, rowIndex: number | null) => {
      if (block.type === "paragraph") {
        collect(block, blockIndex, rowIndex);
        return;
      }
      if (typeof block.rows !== "function") return;
      const rows = block.rows();
      for (let ri = 0; ri < rows.length; ri++) {
        for (const cell of rows[ri].cells()) {
          for (const cellBlock of cell.blocklevels()) walk(cellBlock, blockIndex, rowIndex ?? ri);
        }
      }
    };

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) walk(blocks[blockIndex], blockIndex, null);
    return { commit: false, result: occurrences };
  });
}
