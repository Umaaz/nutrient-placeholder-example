// The guard's decision boundaries, and the shadow caret's bookkeeping.
//
// Both are worth pinning because both fail quietly. An off-by-one in `decide` either refuses a
// legitimate edit next to a marker or lets one land inside it, and neither shows up as an
// error — the marker just silently rots. The `accept*` functions have the same property: if
// they forget to shift the marker spans, the NEXT keystroke is judged against stale ranges.
import { describe, expect, it } from "vitest";

import type { CharAnchor } from "@/internal/bandGeometry";
import {
  type CaretState,
  acceptBackspace,
  acceptDelete,
  acceptInsertion,
  isNavigationKey,
  isUntrackable,
  markerRanges,
  moveCaret,
} from "@/internal/caretModel";
import { decide } from "@/internal/placeholderGuard";

//                          1111111111222222222233333
//                0123456789012345678901234567890123
const TEXT = "Dated {{ effective_date }} by and between";
const MARKER_START = TEXT.indexOf("{{");        // 6
const MARKER_END = TEXT.indexOf("}}") + 2;      // 26

/**
 * Anchors for `text` laid out on lines of `perLine` characters, each glyph 10pt wide.
 *
 * A stand-in for the SDK's real layout, but the same shape, so the navigation arithmetic is
 * exercised against something with genuine line boundaries and x positions.
 */
function anchorsFor(text: string, perLine = 12): CharAnchor[] {
  return [...text].map((char, i) => {
    const column = i % perLine;
    const line = Math.floor(i / perLine);
    return {
      char,
      xLeft: column * 10,
      xRight: column * 10 + 10,
      lineIndex: line,
      lineTop: line * 20,
      lineHeight: 16,
    };
  });
}

function caretAt(index: number, text = TEXT): CaretState {
  return {
    blockRef: { sectionIndex: 0, blockIndex: 0 },
    index,
    blockText: text,
    markers: markerRanges(text),
    pageIndex: 0,
    anchors: anchorsFor(text),
    geometryStale: false,
  };
}

describe("markerRanges", () => {
  it("finds a marker's span", () => {
    expect(markerRanges(TEXT)).toEqual([{ start: 6, end: 26, text: "{{ effective_date }}" }]);
  });

  it("finds several, and ignores unclosed braces", () => {
    expect(markerRanges("{{ a }} x {{ b }} y {{ c").map((m) => m.text)).toEqual(["{{ a }}", "{{ b }}"]);
  });

  it("finds none in ordinary prose", () => {
    expect(markerRanges("no markers here at all")).toEqual([]);
  });
});

describe("decide — printable keys", () => {
  it("refuses an insertion strictly inside the marker", () => {
    for (const index of [MARKER_START + 1, MARKER_START + 5, MARKER_END - 1]) {
      const decision = decide("x", caretAt(index));
      expect(decision.blocked).toBe(true);
      expect(decision.reason).toBe("insert-inside-marker");
      expect(decision.marker).toBe("{{ effective_date }}");
    }
  });

  it("allows an insertion immediately BEFORE the marker", () => {
    // At `start` the character lands in the prose ahead of `{{`, leaving the marker whole.
    expect(decide("x", caretAt(MARKER_START)).blocked).toBe(false);
  });

  it("allows an insertion immediately AFTER the marker", () => {
    expect(decide("x", caretAt(MARKER_END)).blocked).toBe(false);
  });

  it("allows insertions well clear of it", () => {
    expect(decide("x", caretAt(0)).blocked).toBe(false);
    expect(decide("x", caretAt(TEXT.length)).blocked).toBe(false);
  });
});

describe("decide — Backspace", () => {
  it("refuses when it would eat a character of the marker", () => {
    // Backspace removes the character BEFORE the caret, so start+1 is the first refusal…
    expect(decide("Backspace", caretAt(MARKER_START + 1)).reason).toBe("backspace-into-marker");
    // …and `end` still eats the final '}', so it is refused too.
    expect(decide("Backspace", caretAt(MARKER_END)).reason).toBe("backspace-into-marker");
  });

  it("allows it at the marker's start, where it eats the prose before it", () => {
    expect(decide("Backspace", caretAt(MARKER_START)).blocked).toBe(false);
  });

  it("allows it one past the marker's end", () => {
    expect(decide("Backspace", caretAt(MARKER_END + 1)).blocked).toBe(false);
  });
});

describe("decide — Delete", () => {
  it("refuses when the character at the caret belongs to the marker", () => {
    expect(decide("Delete", caretAt(MARKER_START)).reason).toBe("delete-into-marker");
    expect(decide("Delete", caretAt(MARKER_END - 1)).reason).toBe("delete-into-marker");
  });

  it("allows it at the marker's end, where it eats the prose after it", () => {
    expect(decide("Delete", caretAt(MARKER_END)).blocked).toBe(false);
  });
});

describe("decide — non-edit keys", () => {
  it("does not treat navigation as an edit", () => {
    for (const key of ["ArrowLeft", "Shift", "F5", "Escape"]) {
      expect(decide(key, caretAt(MARKER_START + 3))).toMatchObject({ blocked: false, reason: "not-an-edit" });
    }
  });
});

describe("the shadow caret's bookkeeping", () => {
  it("moves the caret and the marker span on an accepted insertion before it", () => {
    const after = acceptInsertion(caretAt(0), "X");
    expect(after.blockText).toBe(`X${TEXT}`);
    expect(after.index).toBe(1);
    // The whole marker shifted right, so the NEXT decision is judged correctly.
    expect(after.markers).toEqual([{ start: 7, end: 27, text: "{{ effective_date }}" }]);
  });

  it("leaves the marker span alone for an insertion after it", () => {
    const after = acceptInsertion(caretAt(TEXT.length), "X");
    expect(after.markers).toEqual([{ start: 6, end: 26, text: "{{ effective_date }}" }]);
    expect(after.index).toBe(TEXT.length + 1);
  });

  it("moves the marker span back on an accepted backspace before it", () => {
    const after = acceptBackspace(caretAt(MARKER_START));
    expect(after.index).toBe(MARKER_START - 1);
    expect(after.markers).toEqual([{ start: 5, end: 25, text: "{{ effective_date }}" }]);
    expect(after.blockText).toBe("Dated{{ effective_date }} by and between");
  });

  it("keeps a shifted span in step with the text it describes", () => {
    // The invariant that actually matters: after any accepted edit, each recorded span still
    // covers the marker in the updated text.
    let caret = caretAt(0);
    for (const char of "abc") caret = acceptInsertion(caret, char);
    caret = { ...caret, index: caret.blockText.length };
    for (const char of "xy") caret = acceptInsertion(caret, char);
    for (const marker of caret.markers) {
      expect(caret.blockText.slice(marker.start, marker.end)).toBe(marker.text);
    }
  });

  it("holds the invariant across a backspace too", () => {
    let caret = acceptInsertion(caretAt(0), "Z");
    caret = acceptBackspace({ ...caret, index: 1 });
    expect(caret.blockText).toBe(TEXT);
    for (const marker of caret.markers) {
      expect(caret.blockText.slice(marker.start, marker.end)).toBe(marker.text);
    }
  });

  it("refuses to run off either end of the block", () => {
    expect(acceptBackspace(caretAt(0)).blockText).toBe(TEXT);
    expect(acceptDelete(caretAt(TEXT.length)).blockText).toBe(TEXT);
  });

  it("deletes forward without moving the caret", () => {
    const after = acceptDelete(caretAt(0));
    expect(after.index).toBe(0);
    expect(after.blockText).toBe(TEXT.slice(1));
  });
});

describe("isUntrackable — what is left after navigation is handled", () => {
  const event = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

  it("gives up on keys that restructure the block", () => {
    for (const key of ["Enter", "Tab", "PageUp", "PageDown"]) {
      expect(isUntrackable(event({ key }))).toBe(true);
    }
  });

  it("gives up on any modifier chord, which could be any command at all", () => {
    expect(isUntrackable(event({ key: "z", metaKey: true }))).toBe(true);
    expect(isUntrackable(event({ key: "v", ctrlKey: true }))).toBe(true);
    expect(isUntrackable(event({ key: "a", altKey: true }))).toBe(true);
  });

  it("no longer gives up on arrows — those are followed instead", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(isUntrackable(event({ key }))).toBe(false);
      expect(isNavigationKey(key)).toBe(true);
    }
  });

  it("keeps tracking plain typing and plain deletion", () => {
    for (const key of ["a", "Z", "1", " ", "Backspace", "Delete"]) {
      expect(isUntrackable(event({ key }))).toBe(false);
      expect(isNavigationKey(key)).toBe(false);
    }
  });
});

describe("moveCaret — protection has to survive an arrow key", () => {
  it("steps horizontally in text space", () => {
    expect(moveCaret(caretAt(10), "ArrowLeft")?.index).toBe(9);
    expect(moveCaret(caretAt(10), "ArrowRight")?.index).toBe(11);
  });

  it("keeps protecting the marker after arrowing into it", () => {
    // The whole point: arrow to just inside the marker, then typing is still refused.
    let caret = caretAt(MARKER_START)!;
    caret = moveCaret(caret, "ArrowRight")!;
    expect(caret.index).toBe(MARKER_START + 1);
    expect(decide("x", caret).blocked).toBe(true);
  });

  it("gives up at either end of the block, where the caret leaves it", () => {
    expect(moveCaret(caretAt(0), "ArrowLeft")).toBeNull();
    expect(moveCaret(caretAt(TEXT.length), "ArrowRight")).toBeNull();
  });

  it("moves by line vertically, holding the x position", () => {
    // 12 chars a line, 10pt each. Index 14 is line 1 column 2 → line 0 column 2 is index 2.
    expect(moveCaret(caretAt(14), "ArrowUp")?.index).toBe(2);
    expect(moveCaret(caretAt(2), "ArrowDown")?.index).toBe(14);
  });

  it("gives up above the first line and below the last", () => {
    expect(moveCaret(caretAt(3), "ArrowUp")).toBeNull();
    expect(moveCaret(caretAt(TEXT.length - 1), "ArrowDown")).toBeNull();
  });

  it("goes to the ends of the current line", () => {
    expect(moveCaret(caretAt(15), "Home")?.index).toBe(12);
    expect(moveCaret(caretAt(15), "End")?.index).toBe(24);
  });

  it("still steps horizontally once the geometry is stale, because that needs no geometry", () => {
    const stale = { ...caretAt(10), geometryStale: true };
    expect(moveCaret(stale, "ArrowLeft")?.index).toBe(9);
    expect(moveCaret(stale, "ArrowRight")?.index).toBe(11);
  });

  it("refuses vertical and line-relative movement over stale geometry", () => {
    // An accepted edit changed the text, so the anchor list describes a layout that no longer
    // exists — and a fresh one cannot be derived inside a keydown handler.
    const stale = { ...caretAt(14), geometryStale: true };
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(moveCaret(stale, key)).toBeNull();
    }
  });

  it("marks the geometry stale as soon as an edit is accepted", () => {
    expect(caretAt(0).geometryStale).toBe(false);
    expect(acceptInsertion(caretAt(0), "X").geometryStale).toBe(true);
    expect(acceptBackspace(caretAt(5)).geometryStale).toBe(true);
    expect(acceptDelete(caretAt(0)).geometryStale).toBe(true);
  });

  it("ignores keys it does not handle", () => {
    expect(moveCaret(caretAt(5), "F5")).toBeNull();
  });
});
