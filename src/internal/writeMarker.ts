// ───────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 02 · B — "A way to point at a span of the text you gave us".
//
//  We already know the exact character range to replace: the selection code derived it, and
//  `buildCharAnchors` guarantees those offsets are index-identical to `getPlainText()`. There
//  is still no way to say so. Nothing converts an offset into a `Range`, so the range is
//  recovered by searching for the selected TEXT and stepping `searchText(needle, after)`
//  forward, counting matches, until the ordinal matches the one the offset implies — then
//  verifying the SDK handed back the text we meant before writing over it.
//
//  Two spellings of the same paragraph are compared to make that safe, and the write REFUSES
//  when they disagree. `placeholders.add({ key, range })` over a range built from offsets
//  would delete most of this file.
//
//  `writeMarkerOverOccurrences` at the bottom is the multi-occurrence case — "make the 1st
//  and the 3rd of these into one field" — and it is where the workaround stops being merely
//  awkward. Read its header for why.
// ───────────────────────────────────────────────────────────────────────────────────────
//
// Writing a `{{key}}` marker over the text a mint was made from, in the mounted document.
//
// Goes through the SDK's programmatic transaction rather than `insertContentAtCursor`. The
// editor's insert API does work — its internal selection survives the naming card, the focus
// move and the typing — but it is a silent no-op in `editorMode: "view"`, and it writes wherever
// the SDK's own cursor happens to be, which nothing here can assert. A transaction targets the
// block and range we already derived and can verify what it matched BEFORE replacing it, so a
// write that would land in the wrong place aborts instead.
//
// The SDK re-lays the page out in place afterwards: the layout snapshot the band painter reads
// carries the marker within ~400ms, so no reload is needed.
import type { DocAuthDocument } from "@nutrient-sdk/document-authoring";

import type { BlockRef } from "@/internal/bandGeometry";
import { trace } from "@/internal/trace";

/** Opaque SDK range. Only ever obtained from the SDK and handed straight back to it. */
type TextRange = object;

/** Structural slice of the SDK's text view — only the four members used here. */
type DocAuthTextView = {
  getPlainText: (range?: TextRange) => string;
  searchText: (query: string, after?: TextRange) => { range: TextRange } | undefined;
  setText: (value: string, range?: TextRange) => TextRange;
};

type DraftBlock = { type: string; asTextView: () => DocAuthTextView };

type DraftLike = { body: () => { content: () => { blocklevels: () => DraftBlock[] } } };

/** Where a mint came from: the block, and the range within the block text the overlay derived. */
export type MarkerWriteTarget = {
  blockRef: BlockRef;
  /** The block's text as the LAYOUT spelled it — not necessarily the model's spelling. */
  blockText: string;
  charStart: number;
  charEnd: number;
};

function occurrencesOf(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

/** How many occurrences of `needle` start before `charStart`. */
function occurrenceIndexAt(haystack: string, needle: string, charStart: number): number {
  let index = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && at < charStart; at = haystack.indexOf(needle, at + 1)) index++;
  return index;
}

function rangeOfOccurrence(textView: DocAuthTextView, needle: string, occurrenceIndex: number): TextRange | null {
  trace({
    capability: "mint",
    reach: "public-misuse",
    touched: "searchText(needle, after) stepped N times to reach occurrence N",
    because:
      "We hold exact character offsets, but nothing converts an offset to a Range. The range is recovered by re-searching for the text and counting matches — O(n) per write, and ambiguous whenever the same phrase repeats.",
    ask: "02 · B",
  });
  let found = textView.searchText(needle);
  for (let index = 0; found && index < occurrenceIndex; index++) found = textView.searchText(needle, found.range);
  return found?.range ?? null;
}

/**
 * Replace `blockText[charStart..charEnd]` with `marker` in the mounted document.
 *
 * Resolves false — writing nothing — whenever the target cannot be confirmed: the block index
 * does not hold a paragraph, the derived text is not in the model's spelling of it, the two
 * spellings disagree on how many times it occurs, or the range the SDK matched is not the text
 * we meant. A marker in the wrong paragraph looks correct on the page, so an unconfirmable
 * target is treated as a failure rather than a best guess.
 */
export async function writeMarkerOverText(
  doc: DocAuthDocument,
  target: MarkerWriteTarget,
  marker: string,
): Promise<boolean> {
  const selectedText = target.blockText.slice(target.charStart, target.charEnd);
  if (selectedText.trim().length === 0 || marker.length === 0) return false;

  return doc.transaction<boolean>(async ({ draft }) => {
    const block = (draft as unknown as DraftLike).body().content().blocklevels()[target.blockRef.blockIndex];
    if (!block || block.type !== "paragraph") return { commit: false, result: false };

    const textView = block.asTextView();
    const modelText = textView.getPlainText();
    const modelOccurrences = occurrencesOf(modelText, selectedText);
    if (modelOccurrences === 0 || modelOccurrences !== occurrencesOf(target.blockText, selectedText)) {
      return { commit: false, result: false };
    }

    const range = rangeOfOccurrence(
      textView,
      selectedText,
      occurrenceIndexAt(target.blockText, selectedText, target.charStart),
    );
    if (range === null || textView.getPlainText(range) !== selectedText) return { commit: false, result: false };

    textView.setText(marker, range);
    return { commit: true, result: true };
  });
}


// ───────────────────────────────────────────────────────────────────────────────────────
//  Multi-occurrence writes.
//
//  Ask 01 · property 2 wants a placeholder that "carries a key we choose". One key, one
//  field the author fills once — rendered at every position it appears. The case already
//  names the shape for that: `CommentThreadAnchor` attaches a thread to
//  `TextAnchorRange[]`, "explicitly supporting cross-paragraph and discontiguous anchors".
//  A placeholder wants exactly the same array.
//
//  Doing it over literal text instead costs three things that an anchor array would not:
//
//   1. ORDER MATTERS. Every `setText` rewrites the block's text, so each write shifts the
//      offset of every occurrence after it and invalidates any range obtained before it.
//      Writes therefore go in DESCENDING offset order within each block — then a target's
//      ordinal, counted in the original text, is still its ordinal in the current text,
//      because everything already rewritten sat after it. Ascending order silently
//      corrupts the second write onwards.
//
//   2. IT MUST BE ALL OR NOTHING. A half-marked template — occurrence 1 replaced, 3 not —
//      is indistinguishable from a correct one by inspection. So the whole set goes in ONE
//      transaction and any single unconfirmable target rolls back every write.
//
//   3. ORDINALS DECAY, AND NOTHING REPORTS IT. An ordinal is a position in a snapshot of
//      text. Between listing the occurrences and writing them, any edit that adds or
//      removes an earlier one renumbers the rest — so "the 3rd" now means a different
//      place, and no event carries enough information to notice (ask 02 · C). The guard
//      below is the only defence available: re-derive each range from the text and refuse
//      unless it still matches exactly. It catches the damage; it cannot prevent it.
//      A `TextAnchorRange` maintained by the SDK would simply not have the problem.
// ───────────────────────────────────────────────────────────────────────────────────────

/** One occurrence to replace, addressed by its offsets in the model's spelling of the block. */
export type OccurrenceWriteTarget = {
  blockRef: BlockRef;
  /** The block's text as the MODEL spells it — from `findOccurrences`, not the layout. */
  blockText: string;
  charStart: number;
  charEnd: number;
};

export type OccurrenceWriteResult = {
  /** Occurrences replaced. Zero whenever `refusal` is set — the write is all-or-nothing. */
  written: number;
  /** Why nothing was written, or null on success. */
  refusal: string | null;
};

/** Targets grouped by the block they sit in, each group sorted by DESCENDING offset. */
function groupByBlockDescending(
  targets: readonly OccurrenceWriteTarget[],
): Map<string, OccurrenceWriteTarget[]> {
  const groups = new Map<string, OccurrenceWriteTarget[]>();
  for (const target of targets) {
    const key = `${target.blockRef.blockIndex}|${target.blockRef.rowIndex ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(target);
    else groups.set(key, [target]);
  }
  for (const group of groups.values()) group.sort((a, b) => b.charStart - a.charStart);
  return groups;
}

/**
 * Replace several occurrences with the SAME marker, so they become one keyed field.
 *
 * All or nothing: resolves `{ written: 0, refusal }` and commits nothing if any single
 * target cannot be confirmed. See the block comment above for why each rule is there.
 */
export async function writeMarkerOverOccurrences(
  doc: DocAuthDocument,
  targets: readonly OccurrenceWriteTarget[],
  marker: string,
): Promise<OccurrenceWriteResult> {
  if (targets.length === 0) return { written: 0, refusal: "No occurrences were selected." };
  if (marker.length === 0) return { written: 0, refusal: "The marker is empty." };

  trace({
    capability: "mint",
    reach: "public-misuse",
    touched: `setText over ${targets.length} range${targets.length === 1 ? "" : "s"}, in descending offset order, in one transaction`,
    because:
      "One key over several occurrences has to be applied as N separate text replacements. Each one shifts the offsets of the others, so the order is forced, and a partial result is indistinguishable from a correct one — so it must roll back as a unit.",
    ask: "01 · 2",
  });

  const groups = groupByBlockDescending(targets);

  return doc.transaction<OccurrenceWriteResult>(async ({ draft }) => {
    const refuse = (refusal: string) => ({ commit: false as const, result: { written: 0, refusal } });
    const blocks = (draft as unknown as DraftLike).body().content().blocklevels();

    // ── validate EVERYTHING before writing ANYTHING ──
    // Not per group as it goes: the write is all-or-nothing, so a target that will fail must
    // be found before its siblings have been rewritten. (An earlier version checked only the
    // first target of each group and let a stale sibling through, which committed two wrong
    // writes — see `writeMarker.test.ts`.)
    type Resolved = { textView: DocAuthTextView; group: OccurrenceWriteTarget[] };
    const resolved: Resolved[] = [];

    for (const group of groups.values()) {
      const first = group[0];

      // A table cell's paragraphs are not top-level blocks, and a `BlockRef` names the table
      // block plus a row — not which cell, nor which paragraph inside it. So a table
      // occurrence cannot be addressed for writing at all. Refusing is the honest outcome:
      // this is the addressing poverty of ask 02 · B, not a missing feature here.
      if (first.blockRef.rowIndex !== null && first.blockRef.rowIndex !== undefined) {
        return refuse(
          "One occurrence is inside a table. A block ordinal plus a row does not identify which cell or which paragraph within it, so the range cannot be addressed.",
        );
      }

      const block = blocks[first.blockRef.blockIndex];
      if (!block || block.type !== "paragraph") {
        return refuse(`Block ${first.blockRef.blockIndex} does not hold a paragraph.`);
      }

      const textView = block.asTextView();
      const modelText = textView.getPlainText();

      let previousStart = Number.POSITIVE_INFINITY;
      for (const target of group) {
        // Per TARGET, not per group: two targets in one block can disagree about the block's
        // text, and the one that disagrees is exactly the one that must stop the write.
        // The offsets came from the model's own spelling, so this must still match exactly.
        if (target.blockText !== modelText) {
          return refuse(
            "The paragraph's text changed between listing the occurrences and writing them, so the offsets no longer address what they did.",
          );
        }
        if (target.charStart < 0 || target.charEnd > modelText.length || target.charEnd <= target.charStart) {
          return refuse("One occurrence's offsets fall outside the paragraph.");
        }
        if (modelText.slice(target.charStart, target.charEnd).trim().length === 0) {
          return refuse("One occurrence covers only whitespace.");
        }
        // Descending order, so this target must END at or before the previous one BEGAN.
        // Comparing starts alone is not enough: it catches duplicates but misses a target
        // whose end runs into the next one along.
        if (target.charEnd > previousStart) {
          return refuse("Two of the chosen occurrences are the same one, or they overlap.");
        }
        previousStart = target.charStart;
      }

      resolved.push({ textView, group });
    }

    // ── then write ──
    let written = 0;
    for (const { textView, group } of resolved) {
      // Descending, so each write leaves every remaining target's ordinal intact.
      for (const target of group) {
        const phrase = target.blockText.slice(target.charStart, target.charEnd);
        const ordinal = occurrenceIndexAt(target.blockText, phrase, target.charStart);
        const range = rangeOfOccurrence(textView, phrase, ordinal);
        if (range === null || textView.getPlainText(range) !== phrase) {
          return refuse(`Occurrence ${ordinal + 1} of “${phrase}” could not be confirmed before writing.`);
        }
        textView.setText(marker, range);
        written++;
      }

      // Cheap end-to-end check that the block really did take the writes we think it did,
      // rather than each `setText` having landed somewhere unexpected.
      if (occurrencesOf(textView.getPlainText(), marker) < group.length) {
        return refuse(`The paragraph does not carry ${group.length} copies of ${marker} after writing.`);
      }
    }

    return { commit: true, result: { written, refusal: null } };
  });
}
