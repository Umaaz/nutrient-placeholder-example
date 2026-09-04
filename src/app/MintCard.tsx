// The card that appears over a drag-selection, to name a new field and choose which
// occurrences of the selected phrase it covers.
//
// The occurrence picker is the visible form of case ask 01 · property 2 and ask 02 · B.
// A phrase like a party name appears many times in a contract, and which of them are the
// FIELD is a judgement only the author can make: sometimes just this one, sometimes all of
// them, sometimes — genuinely — the first and the third. All of them bind to ONE key, because
// a template's `{{ party_name }}` is one field filled once and rendered everywhere.
//
// What the SDK gives us to express that is an ordinal counted over a snapshot of text. The
// list below IS that snapshot, which is why `App` hands it back to `add` as `against` — an
// ordinal the author picked here has to be resolved against the text they were looking at,
// not the text at the moment they clicked. See `OCCURRENCE_ORDINALS_ARE_NOT_IDENTITIES` in
// src/proposed/placeholders.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { SelectionAnchor } from "@/internal/useTextSelection";
import type { OccurrenceSelection, PlaceholderCandidate } from "@/proposed/placeholders";

type Props = {
  anchor: SelectionAnchor;
  selectedText: string;
  /** Every occurrence of `selectedText` in the document, in document order. */
  candidates: readonly PlaceholderCandidate[];
  busy: boolean;
  onMint: (key: string, occurrences: OccurrenceSelection) => void;
  onCancel: () => void;
};

/** Keep the card fully on screen: a selection near an edge would otherwise hang off it. */
const EDGE_GAP_PX = 10;

/** Which occurrences the author is choosing. */
type Mode = "selection" | "all" | "pick";

/** A default key from the selected phrase, so the common case is one keystroke. */
function suggestKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .slice(0, 3)
    .join("_")
    .slice(0, 40);
}

/** "1st", "2nd", "3rd", "4th"… for labelling an occurrence the author has to choose between. */
function ordinalLabel(zeroBased: number): string {
  const n = zeroBased + 1;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

export function MintCard({ anchor, selectedText, candidates, busy, onMint, onCancel }: Props) {
  const [key, setKey] = useState(() => suggestKey(selectedText));
  const [mode, setMode] = useState<Mode>("selection");
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  const repeated = candidates.length > 1;

  useEffect(() => {
    setKey(suggestKey(selectedText));
    setMode("selection");
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [selectedText]);

  // Seed the picker with the occurrence the user actually dragged over, so opening it and
  // minting straight away does the same thing as not opening it at all.
  useEffect(() => {
    const own = candidates.find((candidate) => candidate.isSelection);
    setPicked(new Set(own ? [own.ordinal] : []));
  }, [candidates]);

  // Measured and clamped after layout, because the clamp needs the card's real width and the
  // card is sized by its content. Re-run on resize too: the clamp is against the viewport, so
  // a window that changes size leaves a stale placement hanging off an edge. `mode` is a
  // dependency because opening the picker changes the card's height.
  useLayoutEffect(() => {
    const place = () => {
      const card = cardRef.current;
      if (!card) return;
      const { width, height } = card.getBoundingClientRect();
      const half = width / 2;
      const minCenter = half + EDGE_GAP_PX;
      const maxCenter = window.innerWidth - half - EDGE_GAP_PX;
      const left =
        minCenter > maxCenter ? window.innerWidth / 2 : Math.min(Math.max(anchor.clientLeft, minCenter), maxCenter);
      // Flip above the selection when there is no room below it.
      const fitsBelow = anchor.clientTop + height + EDGE_GAP_PX <= window.innerHeight;
      const top = fitsBelow ? anchor.clientTop : Math.max(EDGE_GAP_PX, anchor.clientTop - height - 24);
      setPlaced({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor.clientLeft, anchor.clientTop, selectedText, mode, candidates.length]);

  const selection: OccurrenceSelection = useMemo(() => {
    if (mode === "all") return "all";
    if (mode === "pick") return { ordinals: [...picked].sort((a, b) => a - b) };
    return "selection";
  }, [mode, picked]);

  const chosenCount = mode === "all" ? candidates.length : mode === "pick" ? picked.size : 1;
  const validKey = /^[A-Za-z0-9_.-]{1,64}$/.test(key);
  const canMint = validKey && chosenCount > 0 && !busy;

  const toggle = (ordinal: number) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });

  return (
    <div
      ref={cardRef}
      className="mint"
      // Hidden for the one frame before the clamp is measured, so it never flashes off-edge.
      style={{
        left: placed?.left ?? anchor.clientLeft,
        top: placed?.top ?? anchor.clientTop,
        visibility: placed ? "visible" : "hidden",
      }}
    >
      <div className="mint-row">
        <span className="quoted">&ldquo;{selectedText}&rdquo;</span>
        <input
          ref={inputRef}
          value={key}
          spellCheck={false}
          aria-label="Field key"
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canMint) onMint(key, selection);
            if (event.key === "Escape") onCancel();
          }}
        />
        <button type="button" className="act primary" disabled={!canMint} onClick={() => onMint(key, selection)}>
          {busy ? "writing…" : chosenCount > 1 ? `Mint ×${chosenCount}` : "Mint field"}
        </button>
        <button type="button" className="act" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {repeated && (
        <div className="mint-occurrences">
          <div className="mint-modes">
            <span className="mint-count">
              {candidates.length} occurrences in the document — one key, {chosenCount}{" "}
              {chosenCount === 1 ? "anchor" : "anchors"}
            </span>
            {(
              [
                ["selection", "just this one"],
                ["all", `all ${candidates.length}`],
                ["pick", "pick…"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={`mint-mode${mode === value ? " on" : ""}`}>
                <input
                  type="radio"
                  name="occurrence-mode"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                {label}
              </label>
            ))}
          </div>

          {mode === "pick" && (
            <ul className="mint-pick">
              {candidates.map((candidate) => (
                <li key={candidate.ordinal}>
                  <label>
                    <input
                      type="checkbox"
                      checked={picked.has(candidate.ordinal)}
                      onChange={() => toggle(candidate.ordinal)}
                    />
                    <span className="mint-ord">{ordinalLabel(candidate.ordinal)}</span>
                    <span className="mint-ctx">
                      …{candidate.contextBefore}
                      <mark>{selectedText}</mark>
                      {candidate.contextAfter}…
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {mode === "pick" && picked.size === 0 && (
            <p className="mint-note">Choose at least one occurrence.</p>
          )}
          {chosenCount > 1 && (
            <p className="mint-note">
              These bind to one key — the author fills it once and it renders at every anchor.
              Addressed by ordinal, which is a position in this list rather than an identity, so
              the write re-checks each range against the paragraph it was listed from and
              refuses the whole set if the document moved underneath it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
