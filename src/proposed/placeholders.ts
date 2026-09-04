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
//  Two of the five properties in ask 01 have no internal route at all. They are declared
//  here and throw `UnreachableError`, because that is the honest shape of the request: they
//  cannot be worked around, only added.
//
//    · `protected`        — DocAuthEditorMode is document-WIDE. There is no way to refuse a
//                           keystroke inside one range of an otherwise editable document.
//                           (Ask 01 · property 1 — "the one that matters most".)
//    · `setDisplayValue`  — Rendering a value in place while the stored DOCX keeps the
//                           placeholder needs a distinction between displayed and stored
//                           content that the model does not have.
//                           (Ask 01 · property 5.)
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
import { markerFor, scanMarkers } from "@/internal/scanMarkers";
import { scrollViewportTo } from "@/internal/shadowDom";
import { findPageDivs, findTokenRects, findViewport, getDocumentContext, pageBoxWidthPx } from "@/internal/snapshotLayout";
import { writeMarkerOverText } from "@/internal/writeMarker";

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
    status: "unreachable",
    ask: "01 · 1",
    route:
      "DocAuthEditorMode is document-wide. Nothing scopes editability to a range, and no keystroke is cancellable — the marker can be half-deleted with no symptom.",
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
  /** Ask 01 · 1. Always false, and not settable. */
  readonly protected: false;
  /** Ask 01 · 5. Throws `UnreachableError`. */
  setDisplayValue(value: string | null): Promise<never>;
};

export type PlaceholderRectsResult = { pageIndex: number; rects: PlaceholderRect[] } | null;

export type AddPlaceholderParams = {
  key: string;
  /** The selection to mint from, as this demo's internal lane derived it. */
  from: { blockRef: BlockRef; blockText: string; charStart: number; charEnd: number };
};

/**
 * The `placeholders` namespace, bound to a mounted document.
 *
 * `editor` is a parameter because half of these need the EDITOR, not the document: geometry
 * and scrolling both go through the rendered DOM. In the proposed API they would hang off the
 * document like `comments` does, and the SDK would resolve that itself.
 */
export function placeholders(doc: DocAuthDocument, editor: DocAuthEditor, container: HTMLElement) {
  const build = (field: Awaited<ReturnType<typeof scanMarkers>>[number]): Placeholder => ({
    key: field.key,
    marker: field.marker,
    blocks: field.blocks,
    occurrences: field.occurrences,

    rects: () => {
      const documentContext = getDocumentContext(editor);
      const firstBlock = field.blocks[0];
      const pageDivs = findPageDivs(container);
      if (!documentContext || !firstBlock || pageDivs.length === 0) return null;
      // Which page a block is on is itself unknown until the walk finds it, so every page
      // width is a candidate for the pt→px scale. Page 0's is used, which is correct only
      // because every page in these fixtures is the same size.
      const found = findTokenRects(
        documentContext,
        firstBlock.sectionIndex,
        firstBlock.blockIndex,
        field.marker,
        pageBoxWidthPx(pageDivs[0]),
        firstBlock.rowIndex ?? null,
      );
      return found ? { pageIndex: found.pageIndex, rects: found.rects } : null;
    },

    protected: false,

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

    /** Ask 01 · 2. Shimmed by `writeMarkerOverText`. Resolves false when the write refused. */
    add: async ({ key, from }: AddPlaceholderParams): Promise<boolean> =>
      writeMarkerOverText(doc, from, markerFor(key)),

    /** Ask 02 · D. Shimmed by locating the scroll container in the shadow root. */
    scrollIntoView: (pageIndex: number, topPx: number): boolean => {
      const viewport = findViewport(container);
      const pageDiv = findPageDivs(container)[pageIndex];
      if (!viewport || !pageDiv) return false;
      const pageTop = pageDiv.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      const scale = pageDiv.offsetHeight > 0 ? pageDiv.getBoundingClientRect().height / pageDiv.offsetHeight : 1;
      scrollViewportTo(viewport, viewport.scrollTop + pageTop + topPx * scale - 80);
      return true;
    },

    /** Ask 01 · 1. Declared so the shape is complete; never satisfiable. */
    protect: (): Promise<never> =>
      Promise.reject(
        new UnreachableError(
          "protect",
          "01 · 1",
          "DocAuthEditorMode is document-wide and no keystroke is cancellable, so one range of an editable document cannot be defended",
        ),
      ),
  };
}

export type PlaceholdersNamespace = ReturnType<typeof placeholders>;
