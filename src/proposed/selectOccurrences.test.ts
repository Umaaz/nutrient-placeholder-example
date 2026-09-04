// `selectOccurrences` is the whole answer to "what if we want the first and the third?", so
// the four selector shapes are pinned here.
import { describe, expect, it } from "vitest";

import { type PlaceholderCandidate, selectOccurrences } from "@/proposed/placeholders";

/** Four occurrences in document order; the second one is what the user actually selected. */
const candidates: PlaceholderCandidate[] = [0, 1, 2, 3].map((ordinal) => ({
  ordinal,
  ordinalInBlock: ordinal,
  blockRef: { sectionIndex: 0, blockIndex: 0 },
  blockText: "Acme and Acme agree that Acme shall notify Acme in writing.",
  charStart: ordinal * 10,
  charEnd: ordinal * 10 + 4,
  contextBefore: "",
  contextAfter: "",
  isSelection: ordinal === 1,
}));

const ordinalsOf = (chosen: readonly PlaceholderCandidate[]) => chosen.map((c) => c.ordinal);

describe("selectOccurrences", () => {
  it('"selection" takes only the one the user dragged over', () => {
    expect(ordinalsOf(selectOccurrences(candidates, "selection"))).toEqual([1]);
  });

  it('"all" takes every occurrence', () => {
    expect(ordinalsOf(selectOccurrences(candidates, "all"))).toEqual([0, 1, 2, 3]);
  });

  it("takes the 1st and the 3rd by ordinal", () => {
    expect(ordinalsOf(selectOccurrences(candidates, { ordinals: [0, 2] }))).toEqual([0, 2]);
  });

  it("returns ordinals in document order however they were listed", () => {
    // The write refuses duplicates and depends on a stable order, so the selector normalises.
    expect(ordinalsOf(selectOccurrences(candidates, { ordinals: [2, 0] }))).toEqual([0, 2]);
    expect(ordinalsOf(selectOccurrences(candidates, { ordinals: [2, 0, 2] }))).toEqual([0, 2]);
  });

  it("ignores ordinals that do not exist", () => {
    expect(ordinalsOf(selectOccurrences(candidates, { ordinals: [0, 99] }))).toEqual([0]);
    expect(ordinalsOf(selectOccurrences(candidates, { ordinals: [] }))).toEqual([]);
  });

  it("takes the first n with a limit", () => {
    expect(ordinalsOf(selectOccurrences(candidates, { limit: 2 }))).toEqual([0, 1]);
    expect(ordinalsOf(selectOccurrences(candidates, { limit: 0 }))).toEqual([]);
    expect(ordinalsOf(selectOccurrences(candidates, { limit: -3 }))).toEqual([]);
    // A limit past the end is not an error, it is just everything.
    expect(ordinalsOf(selectOccurrences(candidates, { limit: 99 }))).toEqual([0, 1, 2, 3]);
  });

  it("takes anything a predicate accepts", () => {
    const evens = selectOccurrences(candidates, (candidate) => candidate.ordinal % 2 === 0);
    expect(ordinalsOf(evens)).toEqual([0, 2]);
  });

  it("never mutates the candidate list", () => {
    const before = ordinalsOf(candidates);
    selectOccurrences(candidates, "all").reverse();
    selectOccurrences(candidates, { ordinals: [3, 1] });
    expect(ordinalsOf(candidates)).toEqual(before);
  });
});
