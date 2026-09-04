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
