// ─────────────────────────────────────────────────────────────────────────────────────────
//  INTERNAL LANE.  Case ask 01 · property 1 — "Typing inside the region, or backspacing into
//  it, is refused or replaces the whole region."
//
//  This is the closest thing to that which can be built from outside the SDK, and it does
//  work — but read what it takes and where it fails, because both matter more than the fact
//  that it works.
//
//  ── WHICH LISTENER ACTUALLY STOPS A CHARACTER ──
//  Measured against SDK 1.19.1 in a headless browser, one edit path at a time. `pd` is
//  `preventDefault()`, `sip` is `stopImmediatePropagation()`, all on a capture-phase listener
//  on the editor's container:
//
//      guard                       type    paste   IME     backspace  undo
//      ─────────────────────────────────────────────────────────────────────
//      (none)                      leak    leak    leak    leak       leak
//      keydown + pd                BLOCK   BLOCK   leak    leak       leak
//      keydown + sip               leak    leak    leak    BLOCK      BLOCK
//      beforeinput + pd            BLOCK   leak    leak    leak       leak
//      beforeinput + sip           leak    leak    leak    leak       leak
//      input + sip                 BLOCK   leak    leak    leak       leak
//      keydown + pd + beforeinput  BLOCK   BLOCK   leak    leak       —
//      keydown + pd + sip          BLOCK   BLOCK   leak    BLOCK      BLOCK   ← used here
//
//  So `keydown` with BOTH `preventDefault` and `stopImmediatePropagation` is the only
//  configuration that holds typing, paste, backspace and undo together. There is no
//  documented interception point; this is an empirical result about which DOM event the SDK
//  happens to read, and an implementation change could move it silently.
//
//  ── WHAT STILL GETS THROUGH ──
//  IME composition leaked through EVERY configuration tested. So this guard does not protect
//  a placeholder from a user typing Japanese, Chinese or Korean — which for a legal-document
//  product is not a nicety.
//
//  ── AND THE REAL PROBLEM ──
//  Deciding requires knowing where the caret is, and that has to be maintained by hand (see
//  `caretModel.ts`). The moment the model goes null — an arrow key, Home, Enter, a scroll,
//  an edit from anywhere else — the guard has exactly two options, and both are wrong:
//  refuse every keystroke in the document, or allow one that damages a marker. This demo
//  takes the second and shows you when it is happening, because that is the failure a real
//  product would ship.
//
//  A `placeholder.protected = true` the editor itself honours has none of these problems:
//  no DOM interception, no shadow caret, no IME hole, and no undecidable state.
// ─────────────────────────────────────────────────────────────────────────────────────────
import {
  type CaretState,
  acceptBackspace,
  acceptDelete,
  acceptInsertion,
  isNavigationKey,
  isUntrackable,
  moveCaret,
} from "@/internal/caretModel";
import { trace } from "@/internal/trace";

/** What the guard decided about one keystroke. */
export type GuardDecision = {
  key: string;
  /** Caret index the decision was made at, or null when the caret was unknown. */
  index: number | null;
  blocked: boolean;
  /** The marker that would have been damaged, when one would. */
  marker: string | null;
  reason:
    | "backspace-into-marker"
    | "delete-into-marker"
    | "insert-inside-marker"
    | "allowed"
    /** The caret model was null, so nothing could be decided. This is the interesting one. */
    | "caret-unknown"
    /** Navigation the model followed — the caret moved and protection held. */
    | "navigated"
    /** Not an edit key — a modifier chord, a function key, a bare Shift. */
    | "not-an-edit";
};

/**
 * Would this keystroke damage a marker?
 *
 * Deliberately narrow. It refuses an edit that lands strictly INSIDE a marker's span, and
 * allows one that merely abuts it:
 *
 *   · Backspace deletes the character before the caret, so it is refused when `index - 1`
 *     falls inside the marker. At `index === start` it deletes the character before `{{`,
 *     which is ordinary prose, and is allowed.
 *   · Delete removes the character at the caret, so it is refused when `index` is inside.
 *   · A printable key inserts at the caret, so it is refused strictly between `start` and
 *     `end` — inserting immediately before `{{` or after `}}` is fine.
 */
export function decide(key: string, caret: CaretState): GuardDecision {
  const { index, markers } = caret;
  const destructive = key === "Backspace" || key === "Delete";
  const printable = key.length === 1;
  if (!destructive && !printable) {
    return { key, index, blocked: false, marker: null, reason: "not-an-edit" };
  }

  for (const marker of markers) {
    if (key === "Backspace" && index - 1 >= marker.start && index - 1 < marker.end) {
      return { key, index, blocked: true, marker: marker.text, reason: "backspace-into-marker" };
    }
    if (key === "Delete" && index >= marker.start && index < marker.end) {
      return { key, index, blocked: true, marker: marker.text, reason: "delete-into-marker" };
    }
    if (printable && index > marker.start && index < marker.end) {
      return { key, index, blocked: true, marker: marker.text, reason: "insert-inside-marker" };
    }
  }
  return { key, index, blocked: false, marker: null, reason: "allowed" };
}

export type InstallGuardParams = {
  container: HTMLElement;
  /** Reads the current shadow caret. Null means we do not know where it is. */
  getCaret: () => CaretState | null;
  /** Replaces the shadow caret after an accepted edit, or clears it when untrackable. */
  setCaret: (caret: CaretState | null) => void;
  /** Every decision, so the UI can show what happened and why. */
  onDecision: (decision: GuardDecision) => void;
};

/**
 * Install the keystroke guard. Returns an uninstaller.
 *
 * Capture phase, and it calls both `preventDefault()` and `stopImmediatePropagation()` — see
 * the table in this file's header for why nothing less holds.
 */
export function installPlaceholderGuard({
  container,
  getCaret,
  setCaret,
  onDecision,
}: InstallGuardParams): () => void {
  trace({
    capability: "guard",
    reach: "dom-shape",
    touched: "capture-phase keydown + preventDefault() + stopImmediatePropagation() on the editor container",
    because:
      "Nothing scopes editability to a range — DocAuthEditorMode is document-wide — so a keystroke that would damage a placeholder can only be stopped by intercepting the DOM event the SDK happens to read. Measured: this is the one configuration that holds typing, paste, backspace and undo. IME composition leaks through all of them.",
    ask: "01 · 1",
  });

  const handler = (event: KeyboardEvent) => {
    // Keys that restructure the block, or any modifier chord: nothing to follow, so drop the
    // model rather than let the next decision be made against a stale one.
    if (isUntrackable(event)) {
      if (getCaret() !== null) setCaret(null);
      onDecision({ key: event.key, index: null, blocked: false, marker: null, reason: "not-an-edit" });
      return;
    }

    // Navigation is FOLLOWED rather than surrendered to — see `moveCaret`. This is what keeps
    // protection alive through an arrow key, and it is caret navigation reimplemented against
    // the SDK's own layout data because the SDK reports none of it.
    if (isNavigationKey(event.key)) {
      const current = getCaret();
      if (current === null) return;
      const moved = moveCaret(current, event.key);
      setCaret(moved);
      onDecision({
        key: event.key,
        index: moved?.index ?? null,
        blocked: false,
        marker: null,
        // Null means the caret left the block, or the geometry was stale — either way we no
        // longer know where it is.
        reason: moved === null ? "caret-unknown" : "navigated",
      });
      return;
    }

    const caret = getCaret();
    const destructive = event.key === "Backspace" || event.key === "Delete";
    const printable = event.key.length === 1;
    if (!destructive && !printable) return;

    if (caret === null) {
      // The document is still editable here. A marker can be damaged and we cannot tell.
      // Refusing instead would make the whole document read-only until the next click.
      onDecision({ key: event.key, index: null, blocked: false, marker: null, reason: "caret-unknown" });
      return;
    }

    const decision = decide(event.key, caret);
    onDecision(decision);

    if (decision.blocked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // Accepted — so our own model of the text, the caret and the marker spans all move.
    if (printable) setCaret(acceptInsertion(caret, event.key));
    else if (event.key === "Backspace") setCaret(acceptBackspace(caret));
    else if (event.key === "Delete") setCaret(acceptDelete(caret));
  };

  container.addEventListener("keydown", handler, { capture: true });
  return () => container.removeEventListener("keydown", handler, { capture: true });
}
