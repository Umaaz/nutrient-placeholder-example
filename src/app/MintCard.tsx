// The card that appears over a drag-selection, to name a new field.
//
// Positioned by us, in client px, at coordinates computed by un-zooming a page rect — see
// `useTextSelection`. `placeholders.add({ key, fromSelection: true })` plus a public geometry
// API would let this sit on a real anchor instead.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SelectionAnchor } from "@/internal/useTextSelection";

type Props = {
  anchor: SelectionAnchor;
  selectedText: string;
  busy: boolean;
  onMint: (key: string) => void;
  onCancel: () => void;
};

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

/** Keep the card fully on screen: a selection near an edge would otherwise hang off it. */
const EDGE_GAP_PX = 10;

export function MintCard({ anchor, selectedText, busy, onMint, onCancel }: Props) {
  const [key, setKey] = useState(() => suggestKey(selectedText));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    setKey(suggestKey(selectedText));
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [selectedText]);

  // Measured and clamped after layout, because the clamp needs the card's real width and the
  // card is sized by its content (the quoted phrase).
  useLayoutEffect(() => {
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
  }, [anchor.clientLeft, anchor.clientTop, selectedText]);

  const valid = /^[A-Za-z0-9_.-]{1,64}$/.test(key);

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
      <span className="quoted">&ldquo;{selectedText}&rdquo;</span>
      <input
        ref={inputRef}
        value={key}
        spellCheck={false}
        aria-label="Field key"
        onChange={(event) => setKey(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && valid && !busy) onMint(key);
          if (event.key === "Escape") onCancel();
        }}
      />
      <button type="button" className="act primary" disabled={!valid || busy} onClick={() => onMint(key)}>
        {busy ? "writing…" : "Mint field"}
      </button>
      <button type="button" className="act" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
