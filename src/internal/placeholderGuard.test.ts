// The guard's decision boundaries, and the shadow caret's bookkeeping.
//
// Both are worth pinning because both fail quietly. An off-by-one in `decide` either refuses a
// legitimate edit next to a marker or lets one land inside it, and neither shows up as an
// error — the marker just silently rots. The `accept*` functions have the same property: if
// they forget to shift the marker spans, the NEXT keystroke is judged against stale ranges.
import { describe, expect, it } from "vitest";

import { type CaretState, acceptBackspace, acceptDelete, acceptInsertion, isUntrackable, markerRanges } from "@/internal/caretModel";
import { decide } from "@/internal/placeholderGuard";

//                          1111111111222222222233333
//                0123456789012345678901234567890123
const TEXT = "Dated {{ effective_date }} by and between";
const MARKER_START = TEXT.indexOf("{{");        // 6
const MARKER_END = TEXT.indexOf("}}") + 2;      // 26

function caretAt(index: number, text = TEXT): CaretState {
  return {
    blockRef: { sectionIndex: 0, blockIndex: 0 },
    index,
    blockText: text,
    markers: markerRanges(text),
    pageIndex: 0,
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

describe("isUntrackable — the size of the problem", () => {
  const event = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;

  it("gives up on anything that moves the caret by layout rather than by text", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) {
      expect(isUntrackable(event({ key }))).toBe(true);
    }
  });

  it("gives up on keys that restructure the block", () => {
    expect(isUntrackable(event({ key: "Enter" }))).toBe(true);
    expect(isUntrackable(event({ key: "Tab" }))).toBe(true);
  });

  it("gives up on any modifier chord, which could be any command at all", () => {
    expect(isUntrackable(event({ key: "z", metaKey: true }))).toBe(true);
    expect(isUntrackable(event({ key: "v", ctrlKey: true }))).toBe(true);
    expect(isUntrackable(event({ key: "a", altKey: true }))).toBe(true);
  });

  it("keeps tracking plain typing and plain deletion", () => {
    for (const key of ["a", "Z", "1", " ", "Backspace", "Delete"]) {
      expect(isUntrackable(event({ key }))).toBe(false);
    }
  });
});
