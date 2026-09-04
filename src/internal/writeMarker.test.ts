// Tests for the multi-occurrence write, against a fake that models the SDK's text view the
// way the real one behaves: an opaque range, a `searchText` that steps forward from a
// previous range, and a `setText` that REWRITES the string — which is what makes offsets
// shift and write order load-bearing.
//
// The ordering rule in `writeMarkerOverOccurrences` cannot be verified by inspection: writing
// occurrences ascending produces a plausible-looking string that is quietly wrong. So the
// fake is here to make that failure mode executable.
import { describe, expect, it } from "vitest";

import type { BlockRef } from "@/internal/bandGeometry";
import { type OccurrenceWriteTarget, writeMarkerOverOccurrences } from "@/internal/writeMarker";

type FakeRange = { start: number; end: number };

/** A paragraph whose text view behaves like the SDK's. */
function fakeParagraph(initial: string) {
  let text = initial;
  const calls: string[] = [];
  return {
    type: "paragraph",
    get text() {
      return text;
    },
    calls,
    asTextView: () => ({
      getPlainText: (range?: object) => {
        const r = range as FakeRange | undefined;
        return r ? text.slice(r.start, r.end) : text;
      },
      searchText: (query: string, after?: object) => {
        const from = after ? (after as FakeRange).end : 0;
        const at = text.indexOf(query, from);
        return at === -1 ? undefined : { range: { start: at, end: at + query.length } };
      },
      setText: (value: string, range?: object) => {
        const r = (range as FakeRange | undefined) ?? { start: 0, end: text.length };
        calls.push(`setText(${JSON.stringify(value)}, ${r.start}..${r.end})`);
        text = text.slice(0, r.start) + value + text.slice(r.end);
        return { start: r.start, end: r.start + value.length };
      },
    }),
  };
}

/** A document whose `transaction` honours `commit`, so a rollback really discards writes. */
function fakeDoc(paragraphs: ReturnType<typeof fakeParagraph>[]) {
  const snapshots = paragraphs.map((p) => p.text);
  return {
    transaction: async <T,>(
      run: (ctx: { draft: unknown }) => Promise<{ commit: boolean; result: T }>,
    ): Promise<T> => {
      const draft = { body: () => ({ content: () => ({ blocklevels: () => paragraphs }) }) };
      const { commit, result } = await run({ draft });
      if (!commit) {
        // Roll every paragraph back to how it started, the way an uncommitted draft would.
        paragraphs.forEach((paragraph, index) => {
          const view = paragraph.asTextView();
          view.setText(snapshots[index]);
          paragraph.calls.length = 0;
        });
      }
      return result;
    },
  };
}

const ref = (blockIndex: number): BlockRef => ({ sectionIndex: 0, blockIndex });

/** A target addressing the `nth` (0-based) occurrence of `phrase` in `blockText`. */
function targetFor(blockText: string, phrase: string, nth: number, blockIndex = 0): OccurrenceWriteTarget {
  let at = blockText.indexOf(phrase);
  for (let i = 0; i < nth; i++) at = blockText.indexOf(phrase, at + phrase.length);
  if (at < 0) throw new Error(`No occurrence ${nth} of "${phrase}"`);
  return { blockRef: ref(blockIndex), blockText, charStart: at, charEnd: at + phrase.length };
}

// Four occurrences of "Acme", so "the 1st and the 3rd" is a real question.
const PARA = "Acme and Acme agree that Acme shall notify Acme in writing.";
const MARKER = "{{ party }}";

describe("writeMarkerOverOccurrences", () => {
  it("writes a single occurrence, leaving its siblings alone", async () => {
    const paragraph = fakeParagraph(PARA);
    const result = await writeMarkerOverOccurrences(
      fakeDoc([paragraph]) as never,
      [targetFor(PARA, "Acme", 1)],
      MARKER,
    );
    expect(result).toEqual({ written: 1, refusal: null });
    expect(paragraph.text).toBe("Acme and {{ party }} agree that Acme shall notify Acme in writing.");
  });

  it("writes the 1st and the 3rd, and nothing else", async () => {
    const paragraph = fakeParagraph(PARA);
    const result = await writeMarkerOverOccurrences(
      fakeDoc([paragraph]) as never,
      [targetFor(PARA, "Acme", 0), targetFor(PARA, "Acme", 2)],
      MARKER,
    );
    expect(result).toEqual({ written: 2, refusal: null });
    expect(paragraph.text).toBe(
      "{{ party }} and Acme agree that {{ party }} shall notify Acme in writing.",
    );
  });

  it("writes in descending offset order, which is what keeps the later offsets valid", async () => {
    const paragraph = fakeParagraph(PARA);
    await writeMarkerOverOccurrences(
      // Handed in ASCENDING order on purpose: the implementation must reorder them itself.
      fakeDoc([paragraph]) as never,
      [targetFor(PARA, "Acme", 0), targetFor(PARA, "Acme", 2)],
      MARKER,
    );
    const offsets = paragraph.calls.map((call) => Number(call.match(/, (\d+)\.\./)?.[1]));
    expect(offsets).toEqual([...offsets].sort((a, b) => b - a));
    // And specifically: the third occurrence (offset 25) before the first (offset 0).
    expect(offsets).toEqual([25, 0]);
  });

  it("writes every occurrence when all of them are chosen", async () => {
    const paragraph = fakeParagraph(PARA);
    const targets = [0, 1, 2, 3].map((n) => targetFor(PARA, "Acme", n));
    const result = await writeMarkerOverOccurrences(fakeDoc([paragraph]) as never, targets, MARKER);
    expect(result).toEqual({ written: 4, refusal: null });
    expect(paragraph.text).toBe(
      "{{ party }} and {{ party }} agree that {{ party }} shall notify {{ party }} in writing.",
    );
  });

  it("spans several paragraphs, each ordered independently", async () => {
    const second = "Acme may disclose to Acme only.";
    const paragraphs = [fakeParagraph(PARA), fakeParagraph(second)];
    const result = await writeMarkerOverOccurrences(
      fakeDoc(paragraphs) as never,
      [targetFor(PARA, "Acme", 3, 0), targetFor(second, "Acme", 0, 1), targetFor(PARA, "Acme", 0, 0)],
      MARKER,
    );
    expect(result).toEqual({ written: 3, refusal: null });
    expect(paragraphs[0].text).toBe(
      "{{ party }} and Acme agree that Acme shall notify {{ party }} in writing.",
    );
    expect(paragraphs[1].text).toBe("{{ party }} may disclose to Acme only.");
  });

  it("rolls the WHOLE set back when one target cannot be confirmed", async () => {
    const paragraph = fakeParagraph(PARA);
    const good = targetFor(PARA, "Acme", 0);
    // A target whose blockText disagrees with the model's — the document moved under us.
    const stale: OccurrenceWriteTarget = {
      blockRef: ref(0),
      blockText: "Acme and Acme agree — but this is not what the paragraph says.",
      charStart: 0,
      charEnd: 4,
    };
    const result = await writeMarkerOverOccurrences(fakeDoc([paragraph]) as never, [good, stale], MARKER);

    expect(result.written).toBe(0);
    expect(result.refusal).toMatch(/changed between listing the occurrences and writing them/);
    // The point of all-or-nothing: a half-marked template looks correct by inspection.
    expect(paragraph.text).toBe(PARA);
  });

  it("refuses a block that does not hold a paragraph", async () => {
    const table = { ...fakeParagraph("Acme"), type: "table" };
    const result = await writeMarkerOverOccurrences(
      fakeDoc([table] as never) as never,
      [targetFor("Acme", "Acme", 0)],
      MARKER,
    );
    expect(result).toEqual({ written: 0, refusal: "Block 0 does not hold a paragraph." });
  });

  it("refuses a table occurrence, because a row does not identify a cell", async () => {
    const paragraph = fakeParagraph(PARA);
    const inTable: OccurrenceWriteTarget = {
      blockRef: { sectionIndex: 0, blockIndex: 0, rowIndex: 1 },
      blockText: PARA,
      charStart: 0,
      charEnd: 4,
    };
    const result = await writeMarkerOverOccurrences(fakeDoc([paragraph]) as never, [inTable], MARKER);
    expect(result.written).toBe(0);
    expect(result.refusal).toMatch(/does not identify which cell/);
    expect(paragraph.text).toBe(PARA);
  });

  it("refuses the same occurrence chosen twice", async () => {
    const paragraph = fakeParagraph(PARA);
    const once = targetFor(PARA, "Acme", 2);
    const result = await writeMarkerOverOccurrences(
      fakeDoc([paragraph]) as never,
      [once, { ...once }],
      MARKER,
    );
    expect(result.written).toBe(0);
    expect(result.refusal).toMatch(/the same one, or they overlap/);
    expect(paragraph.text).toBe(PARA);
  });

  it("refuses overlapping occurrences", async () => {
    const text = "aaaa";
    const paragraph = fakeParagraph(text);
    const result = await writeMarkerOverOccurrences(
      fakeDoc([paragraph]) as never,
      [
        { blockRef: ref(0), blockText: text, charStart: 0, charEnd: 3 },
        { blockRef: ref(0), blockText: text, charStart: 2, charEnd: 4 },
      ],
      MARKER,
    );
    expect(result.written).toBe(0);
    expect(result.refusal).toMatch(/the same one, or they overlap/);
    expect(paragraph.text).toBe(text);
  });

  it("refuses offsets that fall outside the paragraph", async () => {
    const paragraph = fakeParagraph(PARA);
    const result = await writeMarkerOverOccurrences(
      fakeDoc([paragraph]) as never,
      [{ blockRef: ref(0), blockText: PARA, charStart: 0, charEnd: PARA.length + 10 }],
      MARKER,
    );
    expect(result.written).toBe(0);
    expect(result.refusal).toMatch(/fall outside the paragraph/);
    expect(paragraph.text).toBe(PARA);
  });

  it("refuses an empty set rather than committing a no-op", async () => {
    const paragraph = fakeParagraph(PARA);
    expect(await writeMarkerOverOccurrences(fakeDoc([paragraph]) as never, [], MARKER)).toEqual({
      written: 0,
      refusal: "No occurrences were selected.",
    });
  });
});
