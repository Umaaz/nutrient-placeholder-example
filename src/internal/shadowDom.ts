// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 02 · A and 02 · D.
//
//  Locating the SDK's rendered page elements and its scroll viewport, so an overlay can be
//  positioned over a page and the document can be scrolled to a field. Both are found by
//  matching CSS the SDK writes for its own reasons, inside a shadow root we do not own.
//  `placeholders.get(key).scrollIntoView()` and a public zoom/geometry API would delete
//  this file.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// The per-page shadow roots are CLOSED, which is why every overlay style in bandPainter.ts
// is an inline style: no stylesheet of ours can reach inside, so CSS custom properties,
// classes and `@keyframes` are all unavailable there.
import { trace } from "@/internal/trace";

/**
 * The white page divs inside the editor's shadow root, in page order. `container` is the
 * element the SDK editor was created into.
 *
 * There is no public accessor for a page element, so they are identified by the inline style
 * the SDK happens to give them: a white background and `position: relative`. Any restyle of
 * the page chrome breaks this, silently — the overlay simply stops finding pages.
 */
export function findPageDivs(container: HTMLElement): HTMLElement[] {
  const shadowRoot = container.children[0]?.shadowRoot;
  if (!shadowRoot) return [];
  trace({
    capability: "paint",
    reach: "dom-shape",
    touched: 'shadowRoot.querySelectorAll(\'div[style*="background-color"][style*="position: relative"]\')',
    because: "No public API returns a page element, so pages are matched by the inline style the SDK gives them.",
    ask: "02 · A",
  });
  const allDivs = shadowRoot.querySelectorAll<HTMLElement>(
    'div[style*="background-color"][style*="position: relative"]',
  );
  const whiteBgs = new Set(["rgb(255, 255, 255)", "#fff", "#ffffff", "white"]);
  return Array.from(allDivs).filter((div) => whiteBgs.has(div.style.backgroundColor));
}

/** The editor's scroll viewport (the overflow div wrapping the pages) inside the shadow root. */
export function findViewport(container: HTMLElement): HTMLElement | null {
  const shadowRoot = container.children[0]?.shadowRoot;
  if (!shadowRoot) return null;
  trace({
    capability: "scroll",
    reach: "dom-shape",
    touched: "shadowRoot.querySelector(\".da-editor-container > div[style*='overflow']\")",
    because: "Scrolling to a field has no public API, so the scroll container is located by its class and inline overflow.",
    ask: "02 · D",
  });
  return shadowRoot.querySelector<HTMLElement>(".da-editor-container > div[style*='overflow']");
}

/**
 * The page's rendered width in natural px, and the same box the SDK maps points onto.
 *
 * This single number is the whole zoom story: `pxPerPt` is derived from it, so every rect the
 * overlay paints is scaled by a value read off a DOM element. The SDK exposes zoom only as a
 * toolbar action and emits no event when it changes, so nothing tells the overlay to recompute
 * — and a ResizeObserver does not fire for zoom, because the page div's own box is what
 * changed. Bands go stale on zoom until something else triggers a repaint. Case ask 02 · D.
 *
 * The SDK sizes these divs `border-box` at an exact width (Letter = 612pt = 816px) with no
 * border, so `clientWidth` reads 814 — short by the hairline its own surface adds. `offsetWidth`
 * is the correct one; do not "fix" the 816/814 gap.
 */
export function pageBoxWidthPx(pageDiv: HTMLElement): number {
  trace({
    capability: "zoom",
    reach: "measured-constant",
    touched: "pageDiv.offsetWidth  →  pxPerPt",
    because:
      "Zoom is not readable and emits no change event, so the pt→px scale is measured off the rendered page and goes stale silently.",
    ask: "02 · D",
  });
  return pageDiv.offsetWidth;
}

/**
 * Scroll the editor's viewport so `top` (in the viewport's own scroll space) comes into view.
 *
 * Case ask 02 · D asks for "scroll-to-position". Its absence costs the caller two things: the
 * scroll container has to be found by a CSS heuristic (`findViewport` above), and the offset
 * has to be assembled by hand from a page element's client rect, the page's own pt→px scale
 * and the field's rect. `placeholder.scrollIntoView()` would be one call with none of it.
 */
export function scrollViewportTo(viewport: HTMLElement, top: number): void {
  const clamped = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
  viewport.scrollTo({ top: clamped, behavior: "smooth" });
}
