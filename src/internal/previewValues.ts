// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 01 · property 5 — "Can display a value without committing it."
//
//  The requirement has two halves that pull against each other:
//
//    (a) the value "renders in place, reflowing like ordinary text";
//    (b) "the stored DOCX keeps the placeholder, not the value".
//
//  (a) is what makes this hard. A value can be drawn OVER the marker with an overlay div —
//  we already paint those — and the document would then be untouched, satisfying (b) for
//  free. But an overlay cannot reflow: `{{ effective_date }}` is 20 characters and
//  "12 March 2026" is 13, so the rest of the paragraph would not move and the value would
//  either be clipped into the marker's box or overlap the text after it. The SDK lays out
//  text; nothing else can.
//
//  So (a) forces the value into the MODEL. And once it is in the model, (b) is no longer
//  free — it is a promise this file has to keep by hand:
//
//    · `applyPreview`  writes the values and records how to undo each one.
//    · `revertPreview` puts the markers back.
//    · every export path has to be wrapped so it reverts, exports, and re-applies.
//
//  There are FIVE such paths on `DocAuthDocument` — `saveDocument`,
//  `saveDocumentJSONString`, `exportPDF`, `exportDOCX` and `export` — and missing any one of
//  them means a template silently saved with its values baked in. Nothing in the API
//  distinguishes "displayed" from "stored": there is no `displayValue`, no content-control
//  (`w:sdt`) access, no field concept at all.
//
//  This is therefore a preview that is really a mutation plus a promise, and the rest of this
//  file is the cost of keeping that promise.
// ─────────────────────────────────────────────────────────────────────────────────────────
import type { DocAuthDocument } from "@nutrient-sdk/document-authoring";

import type { BlockRef } from "@/internal/bandGeometry";
import { markerRanges } from "@/internal/caretModel";
import { trace } from "@/internal/trace";

/** Opaque SDK range. Only ever obtained from the SDK and handed straight back. */
type TextRange = object;

type DocAuthTextView = {
  getPlainText: (range?: TextRange) => string;
  searchText: (query: string, after?: TextRange) => { range: TextRange } | undefined;
  setText: (value: string, range?: TextRange) => TextRange;
};

type DraftBlock = { type: string; asTextView: () => DocAuthTextView };
type DraftLike = { body: () => { content: () => { blocklevels: () => DraftBlock[] } } };

/** One marker that has been replaced by a value, and everything needed to put it back. */
export type PreviewEntry = {
  key: string;
  /** The marker text that was there, e.g. `{{ effective_date }}`. */
  marker: string;
  /** The value now in its place. */
  value: string;
  blockRef: BlockRef;
  /** Offset of `value` in the block's text AFTER the whole apply pass. */
  charStart: number;
};

export type PreviewState = {
  entries: readonly PreviewEntry[];
  /**
   * Each touched block's text as it stood immediately after the apply.
   *
   * This is the revert guard. Keyed by block index. If a block's text has changed by the time
   * we come to revert, the recorded offsets no longer address the values they described, and
   * the revert refuses rather than writing markers over whatever is now there.
   */
  blockTextAfter: ReadonlyMap<number, string>;
};

export type PreviewOutcome =
  | { ok: true; state: PreviewState; applied: number }
  | { ok: false; refusal: string };

function occurrencesOf(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

/** The range of the `occurrenceIndex`-th `needle`, by stepping `searchText`. Ask 02 · B. */
function rangeOfOccurrence(
  textView: DocAuthTextView,
  needle: string,
  occurrenceIndex: number,
): TextRange | null {
  let found = textView.searchText(needle);
  for (let index = 0; found && index < occurrenceIndex; index++) found = textView.searchText(needle, found.range);
  return found?.range ?? null;
}

/**
 * Replace every `{{ key }}` that has a value with that value, and record how to undo it.
 *
 * One transaction, so a partial preview cannot commit. Writes go in DESCENDING offset order
 * within each block for the same reason as `writeMarkerOverOccurrences`: every `setText`
 * shifts the offsets of everything after it.
 *
 * The recorded `charStart` for each value is its offset AFTER the whole pass, computed
 * arithmetically rather than by searching — a value like "2026" may well occur elsewhere in
 * the paragraph, and a search would find the wrong one.
 */
export async function applyPreview(
  doc: DocAuthDocument,
  values: ReadonlyMap<string, string>,
): Promise<PreviewOutcome> {
  const wanted = [...values.entries()].filter(([, value]) => value.length > 0);
  if (wanted.length === 0) return { ok: false, refusal: "No values were supplied." };

  trace({
    capability: "preview",
    reach: "public-misuse",
    touched: "setText over each marker, then a hand-kept record of how to undo it",
    because:
      "A value has to reflow, and only the SDK lays out text — so the value must go into the model. Nothing distinguishes displayed from stored content, so keeping the placeholder in the saved file becomes a promise the host has to keep across all five export paths.",
    ask: "01 · 5",
  });

  return doc.transaction<PreviewOutcome>(async ({ draft }) => {
    const refuse = (refusal: string) => ({ commit: false as const, result: { ok: false as const, refusal } });
    const blocks = (draft as unknown as DraftLike).body().content().blocklevels();
    const entries: PreviewEntry[] = [];
    const blockTextAfter = new Map<number, string>();

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      if (block.type !== "paragraph") continue;
      const textView = block.asTextView();
      let blockText: string;
      try {
        blockText = textView.getPlainText();
      } catch {
        continue;
      }

      // Which markers in this block have a value, in document order.
      const targets = markerRanges(blockText)
        .map((marker) => {
          const key = marker.text.replace(/^\{\{\s*|\s*\}\}$/g, "");
          const value = values.get(key);
          return value === undefined || value.length === 0 ? null : { marker, key, value };
        })
        .filter((target): target is { marker: { start: number; end: number; text: string }; key: string; value: string } => target !== null);

      if (targets.length === 0) continue;

      // Final offsets, computed ascending: each earlier replacement shifts the ones after it
      // by (value.length - marker.length). Arithmetic, not a search — a value can occur
      // elsewhere in the paragraph and a search would find the wrong occurrence.
      let delta = 0;
      const planned = targets.map((target) => {
        const finalStart = target.marker.start + delta;
        delta += target.value.length - target.marker.text.length;
        return { ...target, finalStart };
      });

      // Written descending, so each write leaves the remaining markers' ordinals intact.
      for (const target of [...planned].reverse()) {
        const ordinal = occurrencesOf(blockText.slice(0, target.marker.start), target.marker.text);
        const range = rangeOfOccurrence(textView, target.marker.text, ordinal);
        if (range === null || textView.getPlainText(range) !== target.marker.text) {
          return refuse(`Could not confirm ${target.marker.text} in block ${blockIndex} before replacing it.`);
        }
        textView.setText(target.value, range);
      }

      const after = textView.getPlainText();
      // The arithmetic above is load-bearing for the revert, so check it against reality now
      // rather than discovering it was wrong when we try to put the markers back.
      for (const target of planned) {
        if (after.slice(target.finalStart, target.finalStart + target.value.length) !== target.value) {
          return refuse(
            `Offset bookkeeping disagreed with the document in block ${blockIndex}: “${target.value}” is not at ${target.finalStart}.`,
          );
        }
        entries.push({
          key: target.key,
          marker: target.marker.text,
          value: target.value,
          blockRef: { sectionIndex: 0, blockIndex },
          charStart: target.finalStart,
        });
      }
      blockTextAfter.set(blockIndex, after);
    }

    if (entries.length === 0) return refuse("No placeholder in the document matched the supplied values.");
    return { commit: true, result: { ok: true, state: { entries, blockTextAfter }, applied: entries.length } };
  });
}

export type RevertOutcome = { ok: true; reverted: number } | { ok: false; refusal: string };

/**
 * Put every marker back, undoing a preview.
 *
 * Refuses as a whole — writing markers over text that has moved would corrupt the template
 * rather than restore it. The guard is the per-block text recorded at apply time: if a block
 * has changed at all since, its recorded offsets are meaningless and there is no way to tell
 * which of them still point at a value.
 *
 * That is the sharp end of this approach. Between applying a preview and reverting it, the
 * document is a NORMAL editable document holding real values, and any edit the user makes in
 * a previewed paragraph strands the marker permanently.
 */
export async function revertPreview(doc: DocAuthDocument, state: PreviewState): Promise<RevertOutcome> {
  if (state.entries.length === 0) return { ok: false, refusal: "Nothing to revert." };

  return doc.transaction<RevertOutcome>(async ({ draft }) => {
    const refuse = (refusal: string) => ({ commit: false as const, result: { ok: false as const, refusal } });
    const blocks = (draft as unknown as DraftLike).body().content().blocklevels();

    const byBlock = new Map<number, PreviewEntry[]>();
    for (const entry of state.entries) {
      const group = byBlock.get(entry.blockRef.blockIndex);
      if (group) group.push(entry);
      else byBlock.set(entry.blockRef.blockIndex, [entry]);
    }

    // Validate every block before touching any of them, so a refusal leaves nothing half-done.
    const resolved: { textView: DocAuthTextView; group: PreviewEntry[] }[] = [];
    for (const [blockIndex, group] of byBlock) {
      const block = blocks[blockIndex];
      if (!block || block.type !== "paragraph") return refuse(`Block ${blockIndex} no longer holds a paragraph.`);
      const textView = block.asTextView();
      const expected = state.blockTextAfter.get(blockIndex);
      if (expected === undefined || textView.getPlainText() !== expected) {
        return refuse(
          `Block ${blockIndex} was edited while the preview was showing, so the markers cannot be put back where they came from.`,
        );
      }
      resolved.push({ textView, group: [...group].sort((a, b) => b.charStart - a.charStart) });
    }

    let reverted = 0;
    for (const { textView, group } of resolved) {
      // Descending, so each write leaves the earlier values' offsets intact.
      for (const entry of group) {
        const text = textView.getPlainText();
        if (text.slice(entry.charStart, entry.charStart + entry.value.length) !== entry.value) {
          return refuse(`“${entry.value}” is no longer at offset ${entry.charStart}.`);
        }
        const ordinal = occurrencesOf(text.slice(0, entry.charStart), entry.value);
        const range = rangeOfOccurrence(textView, entry.value, ordinal);
        if (range === null || textView.getPlainText(range) !== entry.value) {
          return refuse(`Could not confirm “${entry.value}” before restoring ${entry.marker}.`);
        }
        textView.setText(entry.marker, range);
        reverted++;
      }
    }

    return { commit: true, result: { ok: true, reverted } };
  });
}

/** What a save of the document right now would actually contain. */
export type SaveAudit = {
  /** Entries whose ORIGINAL marker is present in the saved document. */
  markersKept: number;
  /** Entries whose previewed VALUE is present instead — i.e. baked into the template. */
  valuesBaked: number;
  total: number;
  /** Size of the serialised document, for context. */
  savedChars: number;
};

/**
 * Serialise the document the way a host would to store it, and check what came out.
 *
 * This is the direct test of ask 01 · property 5's second half — "the stored DOCX keeps the
 * placeholder, not the value". `saveDocumentJSONString()` is used rather than `exportDOCX()`
 * only because a DOCX is a zip and its text is deflated; the document content is the same one
 * every export path reads. There are five of those paths — `saveDocument`,
 * `saveDocumentJSONString`, `exportPDF`, `exportDOCX` and `export` — and none of them knows
 * anything about a preview.
 */
export async function auditSavedDocument(
  doc: DocAuthDocument,
  entries: readonly PreviewEntry[],
): Promise<SaveAudit> {
  trace({
    capability: "preview",
    reach: "public-misuse",
    touched: "saveDocumentJSONString() inspected to find out whether a preview leaked into the stored document",
    because:
      "No export path distinguishes a previewed value from real content, so the only way to know what a save would contain is to perform one and read it.",
    ask: "01 · 5",
  });
  const saved = await doc.saveDocumentJSONString();
  let markersKept = 0;
  let valuesBaked = 0;
  for (const entry of entries) {
    if (saved.includes(entry.marker)) markersKept++;
    else if (saved.includes(entry.value)) valuesBaked++;
  }
  return { markersKept, valuesBaked, total: entries.length, savedChars: saved.length };
}

/**
 * Is the document currently safe to store?
 *
 * The honest answer to "does the stored DOCX keep the placeholder": only if every export path
 * is wrapped. This reports whether a preview is live, so a host can refuse to export rather
 * than silently write values into a template.
 */
export function previewIsLive(state: PreviewState | null): boolean {
  return state !== null && state.entries.length > 0;
}
