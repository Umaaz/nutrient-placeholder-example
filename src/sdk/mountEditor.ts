// Booting the Nutrient Document Authoring SDK the way the demo needs it.
//
// Two things here are not obvious from the getting-started guide, and both cost real time to
// find. Neither is part of the case's asks — they are noted because a reader running this
// demo will otherwise hit them.
import DocumentAuthoring from "@nutrient-sdk/document-authoring";
import type { DocAuthDocument, DocAuthEditor } from "@nutrient-sdk/document-authoring";

import { findPageDivs } from "@/internal/shadowDom";

export type MountedEditor = {
  editor: DocAuthEditor;
  doc: DocAuthDocument;
  destroy: () => void;
};

/** How long to wait for the SDK to lay out a first page before giving up on it. */
const LAYOUT_TIMEOUT_MS = 8000;
const LAYOUT_POLL_MS = 50;

/**
 * Resolve once the SDK has rendered at least one page element, or reject on timeout.
 *
 * Needed because `setCurrentDocument` fires no event (landmine 2) and there is nothing else
 * to await: the pages appear some frames later. Anything that reads geometry before this
 * resolves finds an empty layout tree and concludes, wrongly, that no field can be placed.
 */
async function waitForFirstPage(container: HTMLElement, isCancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + LAYOUT_TIMEOUT_MS;
  for (;;) {
    if (isCancelled()) return;
    if (findPageDivs(container).length > 0) return;
    if (Date.now() > deadline) throw new Error("The SDK laid out no page within 8s");
    await new Promise((resolve) => setTimeout(resolve, LAYOUT_POLL_MS));
  }
}

export type MountEditorParams = {
  /** The element the editor is created into. Must already have a non-zero size. */
  container: HTMLElement;
  /** URL of the DOCX to load. */
  url: string;
  /** Called on every `content.change` — which carries NO payload; see below. */
  onContentChange?: () => void;
  /** Called once the document has been attached and the SDK has laid out a first page. */
  onDocumentLoad?: () => void;
  /** Aborts the boot if it returns true — checked around every await. */
  isCancelled?: () => boolean;
};

/**
 * Load a DOCX and mount it in a fresh editor.
 *
 * ── Landmine 1: never pass `document` to `createEditor` ──
 * Passing the document as a create option makes the SDK lay pages out during `createEditor`'s
 * own first pass. Any page laid out inside the window rect at that moment is prepared but
 * never glyph-painted — it stays permanently blank, and its `prepare` can throw uncaught.
 * Reproduced on the bare SDK at 1.17, 1.18 and 1.19. So the editor is created with NO
 * document and the document is attached afterwards with `setCurrentDocument`.
 *
 * ── Landmine 2: `setCurrentDocument` emits no `document.load` ──
 * Attaching that way fires nothing, so anything that would have been driven by the event has
 * to be driven explicitly by the caller after this resolves.
 *
 * ── And the one that IS an ask: `content.change` carries nothing ──
 * It is typed `void` in the published types and fires with zero arguments, so a listener
 * learns only that *something* changed. Every placeholder position in the document has to be
 * re-derived from scratch on each edit. That is case ask 02 · C.
 */
export async function mountEditor({
  container,
  url,
  onContentChange,
  onDocumentLoad,
  isCancelled = () => false,
}: MountEditorParams): Promise<MountedEditor> {
  const system = await DocumentAuthoring.createDocAuthSystem({
    // Optional. Without one the SDK falls back to its trial behaviour, which is enough to
    // reproduce everything this demo shows. Assets come from Nutrient's public CDN by default.
    licenseKey: import.meta.env.VITE_NUTRIENT_LICENSE_KEY || undefined,
  });

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
  const doc = await system.import(response, { format: "docx" });

  // Created with NO document — see landmine 1.
  const editor = await system.createEditor(container, { ui: { ruler: { enabled: false } } });

  if (onContentChange) editor.on("content.change", onContentChange);

  // Attaching is what would fire `document.load`, and does not — see landmine 2.
  editor.setCurrentDocument(doc);

  const destroy = () => {
    editor.destroy?.();
    system.destroy?.();
    // The SDK does not always take its own nodes with it, and a leftover host element makes
    // the next `findPageDivs` read the dead editor's pages.
    container.replaceChildren();
  };

  try {
    await waitForFirstPage(container, isCancelled);
  } catch (error) {
    destroy();
    throw error;
  }
  onDocumentLoad?.();

  return { editor, doc, destroy };
}
