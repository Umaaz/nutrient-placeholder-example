// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 01 · property 4 — "styled in the browser, and tells us when
//  one is clicked".
//
//  The highlight behind a placeholder is not part of the document. It is a plain <div> that
//  this module appends INTO the SDK's page element, absolutely positioned over the glyphs
//  using rects derived in bandGeometry.ts. That has three consequences the case is asking
//  you to remove:
//
//   1. The per-page shadow roots are CLOSED. No stylesheet of ours can reach inside, so
//      every style here is an inline style — no classes, no CSS custom properties, no
//      `@keyframes`. Transitions go through the Web Animations API instead.
//   2. Clicks have to be caught by us, on our own div, and mapped back to a key by hand.
//      There is no region to attach a callback to.
//   3. The bands are pinned to a pt→px scale read off `pageDiv.offsetWidth`, and no zoom
//      event exists — so they go stale the moment the user zooms (ask 02 · D).
//
//  `placeholders.get(key).style = {...}` plus an `on("click")` carrying the key would delete
//  this file, and would also keep the highlight out of the exported DOCX for free — which is
//  already true here, since these divs are never part of the document.
// ─────────────────────────────────────────────────────────────────────────────────────────
import type { TokenRect } from "@/internal/bandGeometry";
import { trace } from "@/internal/trace";

/** Marks our overlay nodes so a repaint can find and remove exactly its own. */
const BAND_ATTR = "data-placeholder-band";
const BAND_KEY_ATTR = "data-placeholder-key";

/** Default yellow for a placeholder. Literal, because no CSS variable can reach in here. */
export const PLACEHOLDER_ACCENT = "#F5C44A";
/** Accent for a field the user just minted, so a new one is distinguishable at a glance. */
export const MINTED_ACCENT = "#7F77DD";

const FILL_REST = 0.24;
const FILL_HOVER = 0.42;
const FILL_DIMMED = 0.1;

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb {
  const raw = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return { r: 245, g: 196, b: 74 };
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${Math.min(1, Math.max(0, alpha))})`;
}

/** One field's paintable geometry on one page. */
export type BandGroup = {
  key: string;
  accentHex: string;
  pageIndex: number;
  /** UNSCALED in-page px, one rect per visual line. */
  rects: readonly TokenRect[];
};

export type PaintState = {
  /** Key under the cursor, in the canvas or the field list. Others recede. */
  hoveredKey: string | null;
  /** Key the user picked from the field list. */
  selectedKey: string | null;
};

function resolveFill(key: string, state: PaintState): number {
  if (state.hoveredKey === key || state.selectedKey === key) return FILL_HOVER;
  if (state.hoveredKey !== null || state.selectedKey !== null) return FILL_DIMMED;
  return FILL_REST;
}

/** Remove every band this module painted into a page. */
export function clearBands(pageDivs: readonly HTMLElement[]): void {
  for (const pageDiv of pageDivs) {
    pageDiv.querySelectorAll(`[${BAND_ATTR}]`).forEach((node) => node.remove());
  }
}

export type PaintBandsParams = {
  pageDivs: readonly HTMLElement[];
  groups: readonly BandGroup[];
  state: PaintState;
  /** Fires when one of our own divs is clicked, since a region cannot carry a callback. */
  onBandClick?: (key: string) => void;
  onBandHover?: (key: string | null) => void;
  /** Fade the bands in on first paint. WAAPI, because `@keyframes` cannot reach the root. */
  animateEntrance?: boolean;
};

/**
 * Paint every band group into its page, replacing whatever was painted before.
 *
 * Synchronous and total: a repaint clears and redraws rather than diffing, because there is no
 * event telling us which field changed (ask 02 · C), so "something moved" is the only signal
 * available and it invalidates everything.
 */
export function paintBands({
  pageDivs,
  groups,
  state,
  onBandClick,
  onBandHover,
  animateEntrance = false,
}: PaintBandsParams): number {
  clearBands(pageDivs);
  if (groups.length === 0) return 0;

  trace({
    capability: "paint",
    reach: "dom-shape",
    touched: "pageDiv.appendChild(<div data-placeholder-band>) with inline styles only",
    because:
      "A highlight has to be our own DOM node inside the SDK's page element. The per-page shadow roots are closed, so no stylesheet, CSS variable or @keyframes of ours can reach it — inline styles and the Web Animations API only.",
    ask: "01 · 4",
  });

  let painted = 0;
  for (const group of groups) {
    const pageDiv = pageDivs[group.pageIndex];
    if (!pageDiv) continue;
    const fill = resolveFill(group.key, state);
    const isEmphasised = state.hoveredKey === group.key || state.selectedKey === group.key;

    for (const rect of group.rects) {
      const band = document.createElement("div");
      band.setAttribute(BAND_ATTR, "");
      band.setAttribute(BAND_KEY_ATTR, group.key);
      // Every one of these is inline out of necessity, not preference.
      Object.assign(band.style, {
        position: "absolute",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        backgroundColor: rgba(group.accentHex, fill),
        borderRadius: "2px",
        boxShadow: isEmphasised ? `0 0 0 1.5px ${rgba(group.accentHex, 0.95)}` : "none",
        pointerEvents: onBandClick || onBandHover ? "auto" : "none",
        cursor: onBandClick ? "pointer" : "default",
        zIndex: isEmphasised ? "3" : "2",
      } satisfies Partial<CSSStyleDeclaration>);

      if (onBandClick) {
        band.addEventListener("click", (event) => {
          event.stopPropagation();
          onBandClick(group.key);
        });
      }
      if (onBandHover) {
        band.addEventListener("pointerenter", () => onBandHover(group.key));
        band.addEventListener("pointerleave", () => onBandHover(null));
      }

      pageDiv.appendChild(band);
      painted++;

      if (animateEntrance) {
        // WAAPI rather than a CSS transition: a closed shadow root takes no stylesheet of
        // ours, and an inline `transition` needs a second frame to have anything to animate
        // from.
        band.animate(
          [
            { opacity: 0, transform: "scaleX(0.92)" },
            { opacity: 1, transform: "scaleX(1)" },
          ],
          { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" },
        );
      }
    }
  }
  return painted;
}
