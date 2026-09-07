// Round-tripping a preview: values in, markers back out, byte-identical.
//
// The interesting cases are the ones where it must REFUSE. A preview is a mutation plus a
// promise to undo it, and the promise is only keepable while nothing else touches the
// paragraph — so "refuses cleanly" is the feature, not an edge case.
import { describe, expect, it } from "vitest";

import { applyPreview, revertPreview } from "@/internal/previewValues";

type FakeRange = { start: number; end: number };

function fakeParagraph(initial: string, type = "paragraph") {
  let text = initial;
  return {
    type,
    get text() {
      return text;
    },
    set text(next: string) {
      text = next;
    },
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
        text = text.slice(0, r.start) + value + text.slice(r.end);
        return { start: r.start, end: r.start + value.length };
      },
    }),
  };
}

function fakeDoc(paragraphs: ReturnType<typeof fakeParagraph>[]) {
  return {
    transaction: async <T,>(run: (ctx: { draft: unknown }) => Promise<{ commit: boolean; result: T }>): Promise<T> => {
      const snapshots = paragraphs.map((p) => p.text);
      const draft = { body: () => ({ content: () => ({ blocklevels: () => paragraphs }) }) };
      const { commit, result } = await run({ draft });
      if (!commit) paragraphs.forEach((p, i) => void (p.text = snapshots[i]));
      return result;
    },
  };
}

const PARA = 'Dated {{ effective_date }} between {{ company_name }} and the "Company".';
const values = (pairs: Record<string, string>) => new Map(Object.entries(pairs));

describe("applyPreview", () => {
  it("replaces a marker with its value, reflowing the rest of the paragraph", async () => {
    const p = fakeParagraph(PARA);
    const outcome = await applyPreview(fakeDoc([p]) as never, values({ effective_date: "12 March 2026" }));
    expect(outcome.ok).toBe(true);
    expect(p.text).toBe('Dated 12 March 2026 between {{ company_name }} and the "Company".');
  });

  it("replaces several in one pass and records where each landed", async () => {
    const p = fakeParagraph(PARA);
    const outcome = await applyPreview(
      fakeDoc([p]) as never,
      values({ effective_date: "12 March 2026", company_name: "Acme Analytics Ltd" }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal);
    expect(p.text).toBe('Dated 12 March 2026 between Acme Analytics Ltd and the "Company".');
    // The recorded offsets are the ones AFTER the whole pass — the second value's offset
    // has moved because the first replacement was shorter than its marker.
    for (const entry of outcome.state.entries) {
      expect(p.text.slice(entry.charStart, entry.charStart + entry.value.length)).toBe(entry.value);
    }
  });

  it("handles a value LONGER than its marker, where offsets shift forward", async () => {
    const p = fakeParagraph("A {{ k }} B {{ k2 }} C");
    const outcome = await applyPreview(
      fakeDoc([p]) as never,
      values({ k: "a much longer value than the marker", k2: "x" }),
    );
    if (!outcome.ok) throw new Error(outcome.refusal);
    for (const entry of outcome.state.entries) {
      expect(p.text.slice(entry.charStart, entry.charStart + entry.value.length)).toBe(entry.value);
    }
  });

  it("spans several paragraphs", async () => {
    const ps = [fakeParagraph("One {{ a }}."), fakeParagraph("Two {{ b }}.")];
    const outcome = await applyPreview(fakeDoc(ps) as never, values({ a: "1", b: "2" }));
    expect(outcome.ok).toBe(true);
    expect(ps[0].text).toBe("One 1.");
    expect(ps[1].text).toBe("Two 2.");
  });

  it("leaves markers with no value alone", async () => {
    const p = fakeParagraph(PARA);
    await applyPreview(fakeDoc([p]) as never, values({ effective_date: "X" }));
    expect(p.text).toContain("{{ company_name }}");
  });

  it("refuses when no supplied key matches, without committing", async () => {
    const p = fakeParagraph(PARA);
    const outcome = await applyPreview(fakeDoc([p]) as never, values({ nonexistent: "X" }));
    expect(outcome).toEqual({ ok: false, refusal: "No placeholder in the document matched the supplied values." });
    expect(p.text).toBe(PARA);
  });

  it("refuses an empty value set", async () => {
    const p = fakeParagraph(PARA);
    expect(await applyPreview(fakeDoc([p]) as never, values({ effective_date: "" }))).toEqual({
      ok: false,
      refusal: "No values were supplied.",
    });
    expect(p.text).toBe(PARA);
  });
});

describe("revertPreview — the promise being kept", () => {
  it("restores the paragraph byte-for-byte", async () => {
    const p = fakeParagraph(PARA);
    const doc = fakeDoc([p]) as never;
    const applied = await applyPreview(doc, values({ effective_date: "12 March 2026", company_name: "Acme Analytics Ltd" }));
    if (!applied.ok) throw new Error(applied.refusal);
    expect(p.text).not.toBe(PARA);

    const outcome = await revertPreview(doc, applied.state);
    expect(outcome).toEqual({ ok: true, reverted: 2 });
    expect(p.text).toBe(PARA);
  });

  it("round-trips a value that occurs elsewhere in the paragraph too", async () => {
    // "2026" is also loose prose here, so a revert that searched for the value rather than
    // using its recorded offset could put the marker back in the wrong place.
    const text = "In 2026 the term {{ year }} applies from 2026 onwards.";
    const p = fakeParagraph(text);
    const doc = fakeDoc([p]) as never;
    const applied = await applyPreview(doc, values({ year: "2026" }));
    if (!applied.ok) throw new Error(applied.refusal);
    expect(p.text).toBe("In 2026 the term 2026 applies from 2026 onwards.");

    expect(await revertPreview(doc, applied.state)).toEqual({ ok: true, reverted: 1 });
    expect(p.text).toBe(text);
  });

  it("round-trips across several paragraphs", async () => {
    const before = ["One {{ a }} and {{ b }}.", "Two {{ c }}."];
    const ps = before.map((t) => fakeParagraph(t));
    const doc = fakeDoc(ps) as never;
    const applied = await applyPreview(doc, values({ a: "1", b: "22", c: "333" }));
    if (!applied.ok) throw new Error(applied.refusal);
    expect(await revertPreview(doc, applied.state)).toEqual({ ok: true, reverted: 3 });
    expect(ps.map((p) => p.text)).toEqual(before);
  });

  it("REFUSES when the paragraph was edited while the preview was showing", async () => {
    // This is the failure that matters. Between apply and revert the document is a normal
    // editable document holding real values, and any edit strands the marker.
    const p = fakeParagraph(PARA);
    const doc = fakeDoc([p]) as never;
    const applied = await applyPreview(doc, values({ effective_date: "12 March 2026" }));
    if (!applied.ok) throw new Error(applied.refusal);

    const previewed = p.text;
    p.text = `${previewed} A sentence the user typed.`;

    const outcome = await revertPreview(doc, applied.state);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toMatch(/edited while the preview was showing/);
    // Nothing written: the value stays, and the template is now stuck holding it.
    expect(p.text).toBe(`${previewed} A sentence the user typed.`);
  });

  it("refuses the WHOLE revert when only one of several blocks moved", async () => {
    const ps = [fakeParagraph("One {{ a }}."), fakeParagraph("Two {{ b }}.")];
    const doc = fakeDoc(ps) as never;
    const applied = await applyPreview(doc, values({ a: "1", b: "2" }));
    if (!applied.ok) throw new Error(applied.refusal);

    ps[1].text = "Two 2. Edited.";
    const outcome = await revertPreview(doc, applied.state);
    expect(outcome.ok).toBe(false);
    // Block 0 is untouched rather than half-restored — a partly-reverted template is worse
    // than one that is uniformly still showing values.
    expect(ps[0].text).toBe("One 1.");
  });

  it("refuses nothing-to-revert rather than reporting success", async () => {
    const p = fakeParagraph(PARA);
    expect(
      await revertPreview(fakeDoc([p]) as never, { entries: [], blockTextAfter: new Map() }),
    ).toEqual({ ok: false, refusal: "Nothing to revert." });
  });
});
