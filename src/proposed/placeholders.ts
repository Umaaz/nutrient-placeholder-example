// ═════════════════════════════════════════════════════════════════════════════════════════
//  PROPOSED LANE.  Case ask 01 — "The feature: protected, keyed text ranges".
//
//  The API this demo wishes it had called: a `placeholders` namespace on the document,
//  shaped the way `comments` and (since 1.19.0) `find` already are.
//
//  This is NOT a mock that fakes its answers. Where a member CAN be built on SDK internals,
//  it is built, and it delegates to the code in `src/internal/` — so the demo's two lanes do
//  the same work and produce the same result. The `manifest` below records, per member, how
//  many distinct reaches past the public API that delegation costs.
//
//  One of the five properties in ask 01 has no internal route at all. It is declared here and
//  throws `UnreachableError`, because that is the honest shape of the request:
//
//    · `setDisplayValue`  — Rendering a value in place while the stored DOCX keeps the
//                           placeholder needs a distinction between displayed and stored
//                           content that the model does not have.
//                           (Ask 01 · property 5.)
//
//  Protection — property 1, "the one that matters most" — turned out NOT to be unreachable,
//  and this repo implements it. See `src/internal/placeholderGuard.ts`. A capture-phase
//  `keydown` listener calling both `preventDefault()` and `stopImmediatePropagation()` does
//  refuse the keystroke, and a hand-maintained shadow caret decides when to. It works. What it
//  cannot do is stay correct: IME composition leaks through every interception point measured,
//  and the moment the shadow caret goes null the guard can only refuse every edit in the
//  document or allow one that damages a marker. So it is declared `degraded`, not
//  `unreachable`, and `protect()` below returns the honest caveats rather than throwing.
//
//  A third is partly reachable and shown as such:
//
//    · DOCX round trip    — `w:sdt` content controls are neither readable nor writable
//                           through the public API, so a placeholder survives a round trip
//                           only as the literal text it already is: unprotected, and
//                           indistinguishable from prose the user typed.
//                           (Ask 01 · property 3.)
// ═════════════════════════════════════════════════════════════════════════════════════════
import type { DocAuthDocument, DocAuthEditor } from "@nutrient-sdk/document-authoring";

import type { BlockRef, TokenRect } from "@/internal/bandGeometry";
import { findOccurrences } from "@/internal/findOccurrences";
import { markerFor, scanMarkers } from "@/internal/scanMarkers";
import { scrollViewportTo } from "@/internal/shadowDom";
import { findPageDivs, findTokenRects, findViewport, getDocumentContext, pageBoxWidthPx } from "@/internal/snapshotLayout";
import { writeMarkerOverOccurrences } from "@/internal/writeMarker";

/** Thrown by a member that cannot be built on internals at any cost. */
export class UnreachableError extends Error {
  constructor(
    readonly member: string,
    readonly ask: string,
    readonly why: string,
  ) {
    super(`placeholders.${member} cannot be implemented on SDK internals — ${why}`);
    this.name = "UnreachableError";
  }
}

/** How a proposed member is served today. */
export type MemberStatus =
  /** Built on SDK internals. Works, at the cost recorded in `reaches`. */
  | "shim"
  /** Partly built: it does something, but not what the ask actually needs. */
  | "degraded"
  /** No internal route exists. Only Nutrient can add it. */
  | "unreachable";

export type ManifestEntry = {
  /** The call as it would be written against the proposed API. */
  signature: string;
  /** One line on what it is for. */
  purpose: string;
  status: MemberStatus;
  /** The case ask this member corresponds to. */
  ask: string;
  /** The internal modules the shim has to go through, or why it cannot. */
  route: string;
};

/**
 * The proposed surface, member by member, with how each is served today.
 *
 * The UI renders the right-hand lane straight from this, so the comparison cannot drift
 * away from what the code actually does.
 */
export const manifest: readonly ManifestEntry[] = [
  {
    signature: "doc.placeholders.all()",
    purpose: "List every placeholder in the document, so the author can be shown a field list.",
    status: "shim",
    ask: "01 · 2",
    route: "scanMarkers — a read-only transaction, a walk of every block, and a regex over each block's plain text.",
  },
  {
    signature: "doc.placeholders.add({ key, fromSelection })",
    purpose: "Turn what the user has selected into a named placeholder.",
    status: "shim",
    ask: "01 · 2",
    route:
      "useTextSelection + selectionGeometry to re-derive the selection from raw pointer coordinates, then writeMarker to recover a Range by stepping searchText().",
  },
  {
    signature: "doc.placeholders.findCandidates(selection)",
    purpose:
      "List every occurrence of the selected phrase, so the author can pick which of them the field covers.",
    status: "shim",
    ask: "02 · B",
    route:
      "findOccurrences — a second full document walk plus String.indexOf, because searchText returns an opaque range and reports no offset, no ordinal and no count.",
  },
  {
    signature: "add({ key, occurrences: \"all\" | { ordinals: [0, 2] } | { limit: n } })",
    purpose:
      "One key over several occurrences — the 1st and the 3rd, all of them, or the first n. A field the author fills once, rendered everywhere it appears.",
    status: "degraded",
    ask: "01 · 2",
    route:
      "writeMarkerOverOccurrences applies N text replacements in one transaction, in descending offset order because each write shifts the others, and rolls the whole set back if any range cannot be re-confirmed. Correct, but the occurrences are addressed by ORDINAL — a position in a snapshot of text, not an identity.",
  },
  {
    signature: "placeholder.anchors  // TextAnchorRange[]",
    purpose:
      "The positions a placeholder is bound to, maintained by the SDK across edits — exactly what CommentThreadAnchor already gives a comment thread.",
    status: "unreachable",
    ask: "01 · 2",
    route:
      "Nothing survives an edit. An ordinal renumbers silently when an earlier occurrence is added or removed, and no event says so (content.change is typed void), so \"the 3rd\" quietly means somewhere else. The guard can refuse the write; it cannot keep the anchor.",
  },
  {
    signature: "placeholder.rects()",
    purpose: "Where the placeholder is on screen, one rectangle per visual line, so a highlight can sit behind it.",
    status: "shim",
    ask: "02 · A",
    route: "snapshotLayout + bandGeometry — a Symbol() probe for the internal layout tree, then per-glyph advance arithmetic.",
  },
  {
    signature: "placeholder.style = { background, border }",
    purpose: "Style the region in the browser, without any of it reaching the exported document.",
    status: "shim",
    ask: "01 · 4",
    route: "bandPainter — our own divs appended into the SDK's page elements, inline styles only because the shadow roots are closed.",
  },
  {
    signature: 'doc.placeholders.on("click", handler)',
    purpose: "Know when the user clicks a placeholder, with the key in hand.",
    status: "shim",
    ask: "01 · 4",
    route: "bandPainter attaches the listener to our own overlay div and maps it back to a key by a data attribute.",
  },
  {
    signature: "placeholder.scrollIntoView()",
    purpose: "Scroll the document to a placeholder the author picked from the field list.",
    status: "shim",
    ask: "02 · D",
    route: "shadowDom.findViewport — the scroll container located by its class and inline overflow inside the shadow root.",
  },
  {
    signature: "placeholder.range()",
    purpose: "Point at the placeholder's span of text, to mark, restyle or replace exactly it.",
    status: "degraded",
    ask: "02 · B",
    route:
      "writeMarker re-searches for the text and counts matches to reach the right ordinal. Correct, but O(n) per call and it must REFUSE whenever two spellings of the paragraph disagree — so some legitimate writes are declined rather than risked.",
  },
  {
    signature: 'doc.placeholders.on("change", handler)',
    purpose: "React to an edit that touched a placeholder — repaint it, or notice it was damaged.",
    status: "degraded",
    ask: "02 · C",
    route:
      "content.change is typed void and fires with no arguments, so the only available reaction is to re-scan and re-derive the entire document on every keystroke.",
  },
  {
    signature: "placeholder.protected = true",
    purpose: "The editor itself refuses a keystroke inside the region, or replaces the whole region.",
    status: "degraded",
    ask: "01 · 1",
    route:
      "placeholderGuard + caretModel. A capture-phase keydown calling preventDefault AND stopImmediatePropagation does refuse typing, paste, backspace and undo — measured, and the only configuration that holds all four. But deciding needs a hand-maintained shadow caret, IME composition leaks through every interception point tested, and when the caret model goes null the guard can only refuse every edit or allow a damaging one.",
  },
  {
    signature: "placeholder.setDisplayValue(text)",
    purpose: "Preview a filled value in place, reflowing like text, while the stored DOCX keeps the placeholder.",
    status: "unreachable",
    ask: "01 · 5",
    route: "The model has no distinction between displayed and stored content, so any value written is the value saved.",
  },
  {
    signature: "// survives a DOCX round trip",
    purpose: "Templates are stored and exchanged as DOCX; w:sdt content controls would make the regions visible to Word too.",
    status: "unreachable",
    ask: "01 · 3",
    route:
      "Content controls are neither readable nor writable through the public API. A placeholder survives a round trip only as the literal text it already is.",
  },
];

/** A rect in unscaled in-page px, one per visual line. */
export type PlaceholderRect = TokenRect;

export type PlaceholderStyle = { background: string; border: string };

export type Placeholder = {
  readonly key: string;
  /** The marker text as it currently appears in the document. */
  readonly marker: string;
  /** Blocks carrying this placeholder. An implementation detail we should not need. */
  readonly blocks: readonly BlockRef[];
  readonly occurrences: number;
  /** Ask 02 · A. Shimmed. */
  rects(): PlaceholderRectsResult;
  /**
   * Ask 01 · 1. Whether the demo's keystroke guard is currently defending this placeholder.
   *
   * Not a property of the document — nothing in the model records it. It reflects whether
   * `installPlaceholderGuard` is running, and even when true the protection is only as good
   * as the shadow caret behind it.
   */
  readonly protected: boolean;
  /** Ask 01 · 5. Throws `UnreachableError`. */
  setDisplayValue(value: string | null): Promise<never>;
};

export type PlaceholderRectsResult = { pageIndex: number; rects: PlaceholderRect[] } | null;

/**
 * One candidate occurrence of a phrase, as `findCandidates` returns them.
 *
 * In the proposed API this would carry a `TextAnchorRange` and `ordinal` would be a
 * convenience, not the address. Here the ordinal IS the address, which is the problem — see
 * `OCCURRENCE_ORDINALS_ARE_NOT_IDENTITIES` below.
 */
export type PlaceholderCandidate = {
  /** 0-based position in document order. */
  ordinal: number;
  /** 0-based position among the occurrences in this block alone. */
  ordinalInBlock: number;
  blockRef: BlockRef;
  blockText: string;
  charStart: number;
  charEnd: number;
  /** Surrounding text, so the author can tell two occurrences apart. */
  contextBefore: string;
  contextAfter: string;
  /** True for the occurrence the user's own selection covers. */
  isSelection: boolean;
};

/**
 * Which occurrences of a repeated phrase become part of the placeholder.
 *
 * A template's `{{ party_name }}` in three places is ONE field, filled once, rendered three
 * times — so this selects the ANCHORS of a single keyed placeholder, not three placeholders.
 * That is the same shape the SDK already uses for comments: `CommentThreadAnchor` attaches a
 * thread to `TextAnchorRange[]`, explicitly supporting discontiguous anchors.
 */
export type OccurrenceSelection =
  /** Only the range the user actually selected. The default, and the cheapest. */
  | "selection"
  /** Every occurrence within `scope`. */
  | "all"
  /** Specific ones by 0-based document order — `{ ordinals: [0, 2] }` is the 1st and the 3rd. */
  | { ordinals: readonly number[] }
  /** The first N in document order. */
  | { limit: number }
  /** Anything else — filter the candidate list yourself. */
  | ((candidate: PlaceholderCandidate) => boolean);

/** Where to look for repeats. The case's own example is "several times in one paragraph". */
export type OccurrenceScope = "document" | "block";

/**
 * Why the selection above is a workaround and not a design.
 *
 * Every variant except `"selection"` addresses occurrences by ORDINAL, and an ordinal is a
 * position in a snapshot of text — not an identity. Between listing the candidates and
 * writing them, any edit that inserts or removes an earlier occurrence renumbers every one
 * after it. "The 3rd" then silently means somewhere else, and no event carries enough
 * information to notice (`content.change` is typed void — ask 02 · C).
 *
 * The guard is only as good as what the caller passes. `add` resolves a selection against a
 * candidate list; if it lists that itself at write time, the ordinals are resolved against the
 * text as it is NOW and "the 3rd" quietly means whatever is third now. So a caller that showed
 * the author a list MUST hand that list back via `against`, and then
 * `writeMarkerOverOccurrences` compares each candidate's `blockText` to the model and refuses
 * the whole set if the paragraph moved.
 *
 * Note what that means: to be safe, the caller has to carry a snapshot of the document's text
 * around between rendering a list and acting on it, and the API has to take it back. An anchor
 * array maintained by the SDK — as comment threads already have — needs none of that, because
 * an anchor is a thing rather than a count. That is the substance of the ask, not the
 * ergonomics.
 */
export const OCCURRENCE_ORDINALS_ARE_NOT_IDENTITIES = true;

export type AddPlaceholderParams = {
  key: string;
  /** The selection to mint from, as this demo's internal lane derived it. */
  from: { blockRef: BlockRef; blockText: string; charStart: number; charEnd: number };
  /** Which occurrences of the selected phrase to bind to `key`. Defaults to `"selection"`. */
  occurrences?: OccurrenceSelection;
  /** Where to look for repeats. Defaults to `"document"`. */
  scope?: OccurrenceScope;
  /**
   * The candidate list the selection was made against — whatever was shown to the author.
   *
   * Pass it whenever an ordinal or a predicate came from a list a human looked at. Each
   * candidate carries the `blockText` it was listed against, and the write refuses the whole
   * set if the model no longer agrees — so an edit between listing and clicking is a visible
   * refusal rather than a silent renumbering.
   *
   * Omit it and `add` lists fresh, which resolves ordinals against the text as it is now.
   * That is correct only when nothing human happened in between.
   */
  against?: readonly PlaceholderCandidate[];
};

/** Resolve an `OccurrenceSelection` against a candidate list, in document order. */
export function selectOccurrences(
  candidates: readonly PlaceholderCandidate[],
  selection: OccurrenceSelection,
): PlaceholderCandidate[] {
  if (selection === "all") return [...candidates];
  if (selection === "selection") return candidates.filter((candidate) => candidate.isSelection);
  if (typeof selection === "function") return candidates.filter(selection);
  if ("ordinals" in selection) {
    // Deduplicated and put back into document order, so `[2, 0]` and `[0, 2]` mean the same
    // thing — the write below depends on a stable order and refuses duplicates outright.
    const wanted = new Set(selection.ordinals);
    return candidates.filter((candidate) => wanted.has(candidate.ordinal));
  }
  return candidates.slice(0, Math.max(0, selection.limit));
}

/**
 * The `placeholders` namespace, bound to a mounted document.
 *
 * `editor` is a parameter because half of these need the EDITOR, not the document: geometry
 * and scrolling both go through the rendered DOM. In the proposed API they would hang off the
 * document like `comments` does, and the SDK would resolve that itself.
 */
export function placeholders(
  doc: DocAuthDocument,
  editor: DocAuthEditor,
  container: HTMLElement,
  /** Whether the keystroke guard is currently installed. See `protected` on a Placeholder. */
  guardActive: () => boolean = () => false,
) {
  const build = (field: Awaited<ReturnType<typeof scanMarkers>>[number]): Placeholder => ({
    key: field.key,
    marker: field.marker,
    blocks: field.blocks,
    occurrences: field.occurrences,

    rects: () => {
      const documentContext = getDocumentContext(editor);
      const pageDivs = findPageDivs(container);
      if (!documentContext || pageDivs.length === 0) return null;
      // Which page a block is on is unknown until the walk finds it, so every page width is a
      // candidate for the pt→px scale. Page 0's is used, which is correct only because every
      // page in these fixtures is the same size.
      const pageDivWidthPx = pageBoxWidthPx(pageDivs[0]);
      // One walk of the internal layout tree PER BLOCK, because the walker takes a single
      // target block and there is no way to ask it for several at once.
      for (const block of field.blocks) {
        const found = findTokenRects(
          documentContext,
          block.sectionIndex,
          block.blockIndex,
          field.marker,
          pageDivWidthPx,
          block.rowIndex ?? null,
        );
        if (found && found.rects.length > 0) return { pageIndex: found.pageIndex, rects: found.rects };
      }
      return null;
    },

    protected: guardActive(),

    setDisplayValue: () =>
      Promise.reject(
        new UnreachableError(
          "setDisplayValue",
          "01 · 5",
          "the model has no distinction between displayed and stored content, so any value written is the value saved",
        ),
      ),
  });

  return {
    /** Ask 01 · 2. Shimmed by `scanMarkers`. */
    all: async (): Promise<Placeholder[]> => (await scanMarkers(doc)).map(build),

    get: async (key: string): Promise<Placeholder | undefined> => {
      const field = (await scanMarkers(doc)).find((candidate) => candidate.key === key);
      return field ? build(field) : undefined;
    },

    /**
     * Ask 01 · 2. Every occurrence of the selected phrase, in document order, so the author
     * can be offered a choice between them.
     *
     * A whole extra document walk, because `searchText` reports no offset, ordinal or count.
     */
    findCandidates: async (
      from: AddPlaceholderParams["from"],
      scope: OccurrenceScope = "document",
    ): Promise<PlaceholderCandidate[]> =>
      findOccurrences({
        doc,
        phrase: from.blockText.slice(from.charStart, from.charEnd),
        selection: { blockRef: from.blockRef, charStart: from.charStart },
        withinBlock: scope === "block" ? from.blockRef : null,
      }),

    /**
     * Ask 01 · 2. Bind `key` to the chosen occurrences of the selected phrase.
     *
     * One key, N anchors — a field the author fills once, rendered everywhere it appears.
     * Shimmed by `writeMarkerOverOccurrences`, which writes the same marker over each chosen
     * range in one transaction and rolls the whole set back if any one of them cannot be
     * confirmed. Resolves the refusal reason, or null on success.
     */
    add: async ({
      key,
      from,
      occurrences = "selection",
      scope = "document",
      against,
    }: AddPlaceholderParams): Promise<{ written: number; refusal: string | null }> => {
      const phrase = from.blockText.slice(from.charStart, from.charEnd);
      // `"selection"` needs no candidate walk: the caller already holds the one range.
      if (occurrences === "selection") {
        return writeMarkerOverOccurrences(
          doc,
          [{ blockRef: from.blockRef, blockText: from.blockText, charStart: from.charStart, charEnd: from.charEnd }],
          markerFor(key),
        );
      }

      // `against` is the list the author actually saw. Re-listing here instead would resolve
      // their ordinals against the text as it is now — see the note above.
      const candidates =
        against ??
        (await findOccurrences({
          doc,
          phrase,
          selection: { blockRef: from.blockRef, charStart: from.charStart },
          withinBlock: scope === "block" ? from.blockRef : null,
        }));
      const chosen = selectOccurrences(candidates, occurrences);
      if (chosen.length === 0) {
        return { written: 0, refusal: `No occurrence of “${phrase}” matched the selection.` };
      }
      return writeMarkerOverOccurrences(
        doc,
        chosen.map((candidate) => ({
          blockRef: candidate.blockRef,
          blockText: candidate.blockText,
          charStart: candidate.charStart,
          charEnd: candidate.charEnd,
        })),
        markerFor(key),
      );
    },

    /**
     * Ask 02 · D. Shimmed by locating the scroll container in the shadow root and assembling
     * the offset by hand from a page's client rect, its own pt→px scale and the field's rect.
     */
    scrollIntoView: (pageIndex: number, topPx: number): boolean => {
      const viewport = findViewport(container);
      const pageDiv = findPageDivs(container)[pageIndex];
      if (!viewport || !pageDiv) return false;
      const rendered = pageDiv.getBoundingClientRect();
      const pageTop = rendered.top - viewport.getBoundingClientRect().top;
      const scale = pageDiv.offsetHeight > 0 ? rendered.height / pageDiv.offsetHeight : 1;
      // A third of the way down rather than flush to the top, so the field lands with its
      // surrounding clause visible.
      scrollViewportTo(viewport, viewport.scrollTop + pageTop + topPx * scale - viewport.clientHeight / 3);
      return true;
    },

    /**
     * Ask 01 · 1. Reports what the demo's guard can and cannot defend.
     *
     * Not a `Promise<never>` any more: protection turned out to be partly buildable, and
     * pretending otherwise would misstate the ask. Turning it on is `installPlaceholderGuard`;
     * this reports the terms it comes with.
     */
    protect: (): {
      supported: boolean;
      defends: readonly string[];
      leaks: readonly string[];
      caveat: string;
    } => ({
      supported: true,
      defends: ["typing", "paste", "backspace", "delete", "undo"],
      leaks: ["IME composition"],
      caveat:
        "Requires a shadow caret maintained outside the SDK, because hasActiveCursor() is a bare boolean. Any arrow key, Home/End, Enter, Tab or modifier chord voids it, and a voided model can only refuse every edit in the document or allow one that damages a marker.",
    }),
  };
}

export type PlaceholdersNamespace = ReturnType<typeof placeholders>;
