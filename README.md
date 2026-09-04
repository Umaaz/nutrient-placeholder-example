# Document placeholders on the Nutrient Document Authoring SDK

A small, self-contained worked example that accompanies Wordsmith's support case
**"Document placeholders"** (API request, SDK 1.19.1).

It does one thing, in two lanes side by side:

- **left — what we do today.** A working placeholder feature, built on the SDK's *internal*
  layout tree, its shadow DOM, and a `Symbol()`-keyed private property. Every reach past the
  public API is instrumented, so the panel on the right of the app counts them as they happen.
- **right — what we should have called.** A `doc.placeholders` namespace, shaped the way
  `comments` and (since 1.19.0) `find` already are. Where a member of it *can* be built on
  internals, it is built and it delegates to the left lane. Where it cannot be built at all,
  it says so.

The app itself is written against the right-hand lane: every action in
[`src/app/App.tsx`](src/app/App.tsx) is a call on that namespace, and the namespace delegates
to [`src/internal/`](src/internal) rather than faking its answers. So the two columns are the
same code path seen from both ends, and the reach counters are what the top half costs the
bottom.

The point is not that the feature is impossible. It ships. The point is what it costs, and
which parts of it cannot be made correct at any price.

```bash
pnpm install && pnpm dev
```

Open the URL it prints, then press **Scan for placeholders**. Requires network: the SDK
fetches its own assets from Nutrient's public CDN. A license key is optional —
copy `.env.example` to `.env` if you want to supply one.

---

## What to look at

| In the app | What it demonstrates | Case ask |
| --- | --- | --- |
| Press **Scan** — nine bands appear | Enumerating placeholders means walking every block and regexing its text | 01 · 2 |
| The bands themselves | A highlight is our own `<div>` inside the SDK's page element, positioned from per-glyph advances | 01 · 4, 02 · A |
| **Drag across a phrase** → name it → Mint | A selection re-derived from raw pointer coordinates, then a range recovered by counting `searchText` matches | 01 · 2, 02 · A, 02 · B |
| Drag across a phrase that **repeats** — e.g. `the Receiving Party` | The card offers *just this one* / *all 6* / *pick…*, and the picker lets you choose the 1st and the 3rd | 01 · 2, 02 · B |
| Hover a field row | Bands recede and emphasise — all inline styles, because the page shadow roots are closed | 01 · 4 |
| Click a field row | Scroll-to-field, via a scroll container located by a CSS heuristic | 02 · D |
| Type in the document | Every placeholder is re-scanned and re-placed from scratch, because the change event carries nothing | 02 · C |
| Switch to `multi-section-nda.docx` and mint past the section break | The write is **refused** — see [Known limitations](#known-limitations) | — |
| The **Internal reaches** log | Each reach, what it touched, and why the public API could not answer | — |

The two right-hand panels are generated from the code, not written by hand: the comparison
lanes render from `manifest` in [`src/proposed/placeholders.ts`](src/proposed/placeholders.ts),
and the log from `trace()` calls at each reach site. Neither can drift away from what the demo
actually did.

---

## The five things ask 01 wants, and where each one stands

Ask 01 asks for a protected, keyed text range. Of its five properties, three can be faked and
two cannot be reached at all.

| Property | Status here | Why |
| --- | --- | --- |
| **1. The user cannot partially edit it** | **Unreachable** | `DocAuthEditorMode` is document-wide. Nothing scopes editability to a range and no keystroke is cancellable, so a marker can be half-deleted, split or reworded with no symptom. This is the one the case calls "the one that matters most", and it is the one nothing in this repo can imitate. |
| **2. Carries a key, and can be enumerated** | Worked around | [`scanMarkers.ts`](src/internal/scanMarkers.ts) — a read-only transaction, a walk of every block, a regex over its plain text. |
| **2a. One key over several positions** | Partly, and unsafely | See [One key, several occurrences](#one-key-several-occurrences). The writes work; the *addressing* does not survive an edit. |
| **3. Survives a DOCX round trip** | **Unreachable** | `w:sdt` content controls are neither readable nor writable through the public API. A placeholder survives a round trip only as the literal text it already is: unprotected, and indistinguishable from prose the user typed. |
| **4. Styled in the browser, and reports clicks** | Worked around | [`bandPainter.ts`](src/internal/bandPainter.ts) — our own divs, inline styles only, our own click listener mapped back to a key. It does at least keep the styling out of the exported document for free, since these divs were never part of it. |
| **5. Can display a value without committing it** | **Unreachable** | The model has no distinction between displayed and stored content, so any value written is the value saved. |

`placeholders.protect()` and `placeholder.setDisplayValue()` exist in this repo's proposed
namespace and reject with an `UnreachableError` that names the ask. That is deliberate: it is
the honest shape of the request. Those two can only be added, not worked around.

---

## One key, several occurrences

A party name, a defined term or a notice period appears many times in a contract, and which of
those occurrences *are* the field is a judgement only the author can make. Sometimes just the
one they selected. Sometimes all of them. Sometimes — genuinely — the first and the third.

They all bind to **one key**: a template's `{{ party_name }}` is one field the author fills
once, rendered everywhere it appears. So this is not N placeholders, it is one placeholder with
N anchors — and the SDK already has that shape. `CommentThreadAnchor` attaches a thread to
`TextAnchorRange[]`, explicitly supporting cross-paragraph and discontiguous anchors. A
placeholder wants the same array:

```ts
// what we would like to write
const hits = await doc.placeholders.findCandidates(selection);
await doc.placeholders.add({ key: "receiver", anchors: [hits[0], hits[2]] });
```

The demo implements the whole thing — `findCandidates`, and `add` with
`"selection" | "all" | { ordinals } | { limit }` or a predicate — so you can watch it work and
watch what it costs. Three things go wrong, and only the third is fatal.

**1. `searchText` reports nothing about what it found.** It returns an opaque range: no offset,
no ordinal, no count, and no way to ask "which number is this one". So offering the author a
choice at all needs a second full walk of the document, reading every paragraph's plain text
and indexing the string by hand — [`findOccurrences.ts`](src/internal/findOccurrences.ts).

**2. Order becomes load-bearing.** Every `setText` rewrites its paragraph, so each write shifts
the offsets of every occurrence after it and invalidates any range obtained before it. The
writes therefore go in **descending** offset order, which is what keeps each remaining target's
ordinal meaning what it meant. Ascending order corrupts the second write onwards and produces a
plausible-looking result. And a half-marked template — occurrence 1 replaced, 3 not — cannot be
told from a correct one by looking, so the whole set goes in one transaction and any single
unconfirmable target rolls all of it back.
[`writeMarker.test.ts`](src/internal/writeMarker.test.ts) pins both rules against a fake that
models `setText` faithfully.

**3. An ordinal is not an identity — and this one cannot be fixed here.** An ordinal is a
position in a snapshot of text. Between the author seeing the list and clicking Mint, any edit
that adds or removes an earlier occurrence renumbers the rest, so "the 3rd" quietly means
somewhere else — and `content.change` is typed `void`, so nothing carries enough information to
notice (ask 02 · C).

The only defence available is to make the caller carry the snapshot around and hand it back:
`add({ …, against })` takes the candidate list the author was actually shown, and the write
compares each candidate's paragraph text to the model and refuses the whole set if it moved.

```
Refused to write {{ receiver }} — The paragraph's text changed between listing the
occurrences and writing them, so the offsets no longer address what they did.
```

That is the honest outcome, and it is still a bad one: the author is told "no" for a request
that was correct when they made it, and the only alternative is to write to the wrong place.
Note also what the guard requires — the API has to accept a copy of the document's own text
back from its caller in order to be safe. An anchor array maintained by the SDK needs none of
it, because an anchor is a thing rather than a count.

> This is the part of ask 01 · property 2 that reads like ergonomics and is not. "Carries a key
> we choose, and can be enumerated" is cheap. Carrying a key across *several positions*, so
> that it still means the same positions after an edit, is the same problem as protection
> (property 1) wearing a different hat.

---

## The four APIs ask 02 wants

Every file under [`src/internal/`](src/internal) exists because one of these is missing.

### 02 · A — Screen position of a text block or selection

The load-bearing one. Two modules and about 700 lines.

- [`snapshotLayout.ts`](src/internal/snapshotLayout.ts) — `getDocumentContext()` iterates
  `Object.getOwnPropertySymbols(doc)` and takes the entry exposing `documentContext`. It is
  matched by the **shape** of its value, never the symbol's description, because that
  description has already been renamed once (`DocAuthImpl` → `DocAuthHeadlessImpl`). A
  description filter would have broken on upgrade, silently.
- [`bandGeometry.ts`](src/internal/bandGeometry.ts) — walks
  `contentArea → bodyParts → lines → segments → elements` and sums per-glyph `advances` to get
  a rectangle. Not one field name in that path appears in any published type.
- [`selectionGeometry.ts`](src/internal/selectionGeometry.ts) — reimplements text hit-testing.
  `getSelectionContent()` returns content but never a position and `hasActiveCursor()` is a
  bare boolean, so a drag is turned into character offsets by mapping pointer coordinates onto
  the same anchors. Measured error: **0 characters**, across soft wraps, hard breaks and tabs.

### 02 · B — A way to point at a span of the text you gave us

[`writeMarker.ts`](src/internal/writeMarker.ts). The offsets are already known and are
index-identical to `getPlainText()`, and there is still no way to say so. The range is
recovered by searching for the selected *text* and stepping `searchText(needle, after)` forward,
counting matches until the ordinal matches the one the offset implies — then verifying the SDK
handed back the text we meant before overwriting it.

It compares two spellings of the paragraph to make that safe and **refuses to write** when they
disagree. A marker in the wrong paragraph looks correct on the page, so an unconfirmable target
has to be treated as a failure rather than a best guess. You can see it refuse: see
[Known limitations](#known-limitations).

### 02 · C — Change events that carry the edited range

The entire public event map, read from the 1.19.1 type definitions:

```ts
export declare type DocAuthEditorEvents = {
    'document.load': void;
    'content.change': void;
};
```

Both are `void` and fire with no arguments. A listener learns that *something* changed. So
every edit re-scans the whole document and re-derives every placeholder's geometry — visible in
the app as the reach counters climbing while you type.

### 02 · D — Zoom level with a change event, and scroll-to-position

[`shadowDom.ts`](src/internal/shadowDom.ts). Both the page elements and the scroll container are
found by matching CSS the SDK writes for its own reasons:

```ts
'div[style*="background-color"][style*="position: relative"]'   // a page
".da-editor-container > div[style*='overflow']"                 // the scroll container
```

And the pt→px scale — which every rectangle in the app is multiplied by — is
`pageDiv.offsetWidth`. Zoom is not readable, emits no event, and does not trigger a
`ResizeObserver` (the page's own box is what changed). **So the bands go stale on zoom** until
some unrelated signal provokes a repaint. The app listens to window `resize` as a stand-in,
which is exactly as unprincipled as it sounds.

---

## Known limitations

These are real and left in on purpose. Each is a consequence of a placeholder being text
rather than a region.

**Minting past a section break is refused.** Load `multi-section-nda.docx`, scroll to the last
page, drag across a phrase and mint it. The write is declined:

> Refused to write `{{ part_c_general }}` — the range could not be confirmed against the
> model's spelling of the paragraph.

Since SDK 1.15 block content hangs off one body-global `body.content()`, so a block ordinal is
body-global — but `resolveBlockAtPoint` counts blocks *per section* as it walks the layout tree.
On a single-section document the two agree. Past a section break they diverge, the block index
addresses the wrong paragraph, the selected text is not in it, and the write fails closed.
`Paragraph.findSection()` cannot reconcile them: it returns a fresh wrapper each call, so the
section it names cannot be identified. With a real range object none of this arithmetic would
exist.

**Fields inside tables get no band.** `scanMarkers` descends into table cells (a signature block
is usually a table, and skipping them means those fields match nothing at all), but the geometry
walkers do not follow a cell's nested content area. Such a field appears in the list marked
*no geometry*.

**Bands go stale on zoom.** See 02 · D above.

**A damaged marker just disappears.** Half-delete a `{{` and the field silently leaves the
list. There is no way to notice the damage, because there was never a region to damage — only
text. That is ask 01 · property 1 restated.

---

## Two landmines that are not part of the case

Worth knowing if you run this, but not things we are asking for.

**Never pass `document` to `createEditor`.** Doing so makes the SDK lay pages out during
`createEditor`'s own first pass; any page laid out inside the window rect at that moment is
prepared but never glyph-painted, and stays permanently blank. Its `prepare` can also throw
uncaught. Reproduced on the bare SDK at 1.17, 1.18 and 1.19. This demo creates the editor with
no document and attaches it afterwards with `setCurrentDocument` — see
[`src/sdk/mountEditor.ts`](src/sdk/mountEditor.ts).

**`setCurrentDocument` emits no `document.load`.** Attaching that way fires nothing, so the
boot has to poll for a first page element rather than await an event.

---

## Layout

```
src/
  internal/     the lane that exists. Every file here is a workaround.
    bandGeometry.ts        rects from per-glyph advances               (02 · A)
    snapshotLayout.ts      the Symbol() probe and the snapshot walk    (02 · A)
    selectionGeometry.ts   text hit-testing, reimplemented             (02 · A)
    shadowDom.ts           page + viewport located by CSS heuristic    (02 · A, 02 · D)
    scanMarkers.ts         enumeration by regex over every block       (01 · 2)
    findOccurrences.ts     a second walk, to index repeats by hand     (02 · B)
    writeMarker.ts         a range recovered by counting searchText,
                           and N of them written in forced order       (02 · B, 01 · 2)
    bandPainter.ts         our own divs, inline styles only            (01 · 4)
    useTextSelection.ts    capture-phase, passive pointer interception (02 · A)
    trace.ts               the instrumentation behind the right panel
  proposed/
    placeholders.ts        the API we wanted, and what each member costs.
                           The app is written AGAINST this file; it delegates
                           to internal/ rather than faking its answers.
  sdk/mountEditor.ts       boot, with the blank-page fix
  app/                     the page itself
```

`src/internal/bandGeometry.ts`, `selectionGeometry.ts` and `snapshotLayout.ts` are ported from
Wordsmith's production code with their unit tests
(`pnpm test` — 75 tests), which run against a **real captured layout snapshot**
in [`src/internal/__fixtures__`](src/internal/__fixtures__) — so the geometry is verifiable
without a browser.

### One deliberate change from our production code

`buildCharAnchors` here emits `vanishing` layout elements at **zero width** rather than skipping
them, and maps the three element types that carry their character only in their `type`
(`s` → space, `tab` → tab, `break/line` → newline).

Skipping them dropped every tab, and dropped *two* characters at a hard break — the break plus
the space before it, which is vanishing too — so any offset past the first break in a block
addressed the wrong text. With the rule applied, this text is index-identical to
`getPlainText()`, which is what makes an offset safe to hand to the model.

The change is behaviour-preserving for geometry, and
[`vanishingRule.test.ts`](src/internal/vanishingRule.test.ts) asserts it: for every part in the
captured snapshot, the rectangles are identical to those the previous implementation produced,
and every added anchor is zero-width whitespace. Filed against our own tracker as DOCS-2504; not
an SDK bug.

---

## Verified against

`@nutrient-sdk/document-authoring` **1.19.1**, the version the case was written against
(`package.json` pins it). The API surface claims above are read from that release's published
type definitions; the caret, selection, event and transaction behaviour was measured in a
headless browser against the same release.
