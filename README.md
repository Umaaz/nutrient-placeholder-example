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

**Try it without cloning anything:** <https://umaaz.github.io/nutrient-placeholder-example/>
— then press **Scan for placeholders**.

Or run it locally:

```bash
pnpm install && pnpm dev
```

Either way, press **Scan for placeholders** first. Requires network: the npm package is a
~10KB loader and the implementation is fetched from Nutrient's public CDN at runtime. A license
key is optional — the demo runs without one; copy `.env.example` to `.env` to supply one.

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
| Switch on **Protect placeholders**, click into a marker and type | The keystroke is refused and the marker survives; arrow keys keep the protection alive, but Enter voids it and the panel says so | 01 · 1 |
| **Fill values** → Fill, then **Check what a save would contain** | Values reflow natively and stay styled — and a save taken now stores 0 of 9 placeholders | 01 · 5 |
| Switch to `multi-section-nda.docx` and mint past the section break | The write is **refused** — see [Known limitations](#known-limitations) | — |
| The **Internal reaches** log | Each reach, what it touched, and why the public API could not answer | — |

The two right-hand panels are generated from the code, not written by hand: the comparison
lanes render from `manifest` in [`src/proposed/placeholders.ts`](src/proposed/placeholders.ts),
and the log from `trace()` calls at each reach site. Neither can drift away from what the demo
actually did.

---

## The five things ask 01 wants, and where each one stands

Ask 01 asks for a protected, keyed text range. Of its five properties, two can be worked
around, two are only *partly* reachable, and one cannot be reached at all.

| Property | Status here | Why |
| --- | --- | --- |
| **1. The user cannot partially edit it** | Partly, and unsafely | It *is* buildable from outside the SDK — this repo does it, and you can switch it on. But it needs a shadow caret maintained by hand, it leaks IME, and it has an undecidable state. See [Protecting a placeholder](#protecting-a-placeholder). |
| **2. Carries a key, and can be enumerated** | Worked around | [`scanMarkers.ts`](src/internal/scanMarkers.ts) — a read-only transaction, a walk of every block, a regex over its plain text. |
| **2a. One key over several positions** | Partly, and unsafely | See [One key, several occurrences](#one-key-several-occurrences). The writes work; the *addressing* does not survive an edit. |
| **3. Survives a DOCX round trip** | **Unreachable** | `w:sdt` content controls are neither readable nor writable through the public API. A placeholder survives a round trip only as the literal text it already is: unprotected, and indistinguishable from prose the user typed. |
| **4. Styled in the browser, and reports clicks** | Worked around | [`bandPainter.ts`](src/internal/bandPainter.ts) — our own divs, inline styles only, our own click listener mapped back to a key. It does at least keep the styling out of the exported document for free, since these divs were never part of it. |
| **5. Can display a value without committing it** | Half of it | The value reflows and stays styled — see [Filling a template in place](#filling-a-template-in-place). But "without committing" is not achievable: it is a real edit plus a promise to undo it, and a save taken while values are showing stores a filled contract. |

Only property 3 is flatly unreachable: `w:sdt` content controls are neither readable nor
writable, so nothing can make a placeholder survive a round trip as anything other than the
literal text it already is.

Two earlier claims in this README were wrong, and both understated the ask by calling it
impossible rather than unsafe. Protection was listed as unreachable on the grounds that no
keystroke was cancellable — it is. And displaying a value was listed as unreachable on the
grounds that the model cannot separate displayed from stored content — it cannot, but that
turns out to block only *half* the requirement. Both are now built, and both sections below
say exactly where they stop working.

---

## Protecting a placeholder

Property 1 is the one the case calls "the one that matters most", and it is the only one of the
five where this repo's answer changed after we measured properly. It is not unreachable. Switch
on **Protect placeholders from editing** in the app, click into `{{ effective_date }}` and type:
the keystroke is refused and the marker stays whole.

Here is what makes it work, and then what makes it not good enough.

### Which listener actually stops a character

There is no documented interception point, so every edit path was tried against SDK 1.19.1 in
a headless browser, one at a time. `pd` is `preventDefault()`, `sip` is
`stopImmediatePropagation()`, both on a capture-phase listener on the editor's container:

| guard | type | paste | IME | backspace | undo |
| --- | --- | --- | --- | --- | --- |
| *(none)* | leak | leak | leak | leak | leak |
| `keydown` + pd | **BLOCK** | **BLOCK** | leak | leak | leak |
| `keydown` + sip | leak | leak | leak | **BLOCK** | **BLOCK** |
| `beforeinput` + pd | **BLOCK** | leak | leak | leak | leak |
| `beforeinput` + sip | leak | leak | leak | leak | leak |
| `input` + sip | **BLOCK** | leak | leak | leak | leak |
| `keydown` + pd + `beforeinput` + pd | **BLOCK** | **BLOCK** | leak | leak | — |
| **`keydown` + pd + sip** | **BLOCK** | **BLOCK** | leak | **BLOCK** | **BLOCK** |

Only the last row holds typing, paste, backspace and undo together, and that is what
[`placeholderGuard.ts`](src/internal/placeholderGuard.ts) installs. Note what this table is: an
empirical result about which DOM event the SDK happens to read. An implementation change moves
it, silently, and the symptom is a placeholder that quietly stops being protected.

### It needs a caret the SDK will not give us

To refuse a keystroke you must know where the caret is. The entire public surface is:

```ts
hasActiveCursor(): boolean      // yes or no. Not where.
getSelectionContent(): Content  // what is selected. Not where it is.
```

So [`caretModel.ts`](src/internal/caretModel.ts) maintains a **shadow caret**: seeded by
hit-testing a click against the internal layout tree, then advanced by every keystroke the
guard allows through. It has to be synchronous — a `keydown` handler cannot await, and reading
the document's text needs a transaction — so the block's text, its marker spans and its
per-character line positions are snapshotted at seed time and maintained locally after that.

Two things make that work at all. Click hit-testing is exact: measured against ground truth
(click where the model says index *i* is, type a sentinel, read the document back) it was 8/10
on a fixture built specifically to break it, and both failures were the tab/hard-break
index-space bug that `buildCharAnchors` now fixes. And tracking holds: seeded once, ten
consecutive keystrokes all landed where predicted.

### Navigation has to be reimplemented too

A guard that dies on the first arrow key protects nothing, because moving the caret is how you
get to the text you want to edit. So `moveCaret` follows navigation rather than surrendering
to it — which means reimplementing caret movement against the SDK's own layout data, since the
SDK performs it internally and reports none of it:

- **Left/Right** are ±1 in text space and need no geometry, so they survive an edit.
- **Up/Down** move by *line*, which is a fact about layout, not text. They use the
  per-character `lineIndex` and x positions from `buildCharAnchors` — find the caret's line and
  x, then take the nearest x on the line above or below.
- **Home/End** are the ends of the current line, so they need the same data.

Verified live: seeding at the left edge of `{{ effective_date }}` and pressing `→` walks the
caret 71 → 72 → 73 → 74, the panel keeps naming the marker it is inside, and typing stays
refused the whole way.

### And then it stops being correct

**IME composition leaks through every configuration in the table.** So a placeholder is not
protected from a user typing Japanese, Chinese or Korean. For a legal-document product that is
not a nicety.

**The model still goes null, and then nothing can be decided.** Four ways, all of them
ordinary:

- **Enter or Tab** restructure the block, so the snapshot no longer describes it.
- **A modifier chord** could be any command at all.
- **Leaving the block** — `←` off the front, `↑` from the first line — moves the caret into a
  paragraph that was never snapshotted.
- **Vertical movement after an edit.** Accepting a keystroke changes the text, so the line
  positions describe a layout that no longer exists. Left/Right still work; `↑`, `↓`, Home and
  End cannot, because re-deriving the layout needs a fresh snapshot and that is not available
  synchronously inside a keydown handler.

A voided model leaves the guard two options, both wrong: refuse every keystroke in the
document, or allow one that damages a marker. This demo takes the second and *shows you*,
because that is the failure a real product would ship. Turn the guard on, click into a marker,
press Enter, then type — the decision log reads:

```
ArrowRight  @74  caret followed
x           @74  insertion inside the marker     ← refused
ArrowRight  @75  caret followed
Enter        —   not an edit                     ← model voided here
x            —   caret unknown, allowed unexamined
```

That last line is the honest measure of this whole approach, and the panel counts them. Each
one is a placeholder that may already be broken, with nothing able to detect it.

> So the ask does not change, but its justification does. It is not "this is impossible".
> It is: the only available implementation depends on out-guessing the SDK about which DOM
> event it reads, and on a caret model that cannot be kept correct — and when it fails, it
> fails silently, in a document whose whole value is that it is exact.

---

## Filling a template in place

Property 5 asks for a value that "renders in place, reflowing like ordinary text, still styled
as a placeholder", while "the stored DOCX keeps the placeholder, not the value". Switch to the
**Fill values** tab and press Fill: the values appear, the paragraphs re-wrap around them, and
each one keeps a highlight in a distinct colour.

The two halves of that requirement pull against each other, and which one you can have is
decided by reflow.

### Why an overlay cannot do it

We already draw our own divs over the document, so the obvious approach is to draw the value
over the marker and leave the document alone — which would satisfy "the stored DOCX keeps the
placeholder" for free, since the document would never change.

It does not work, because `{{ effective_date }}` is 20 characters and `12 March 2026` is 13.
An overlay does not move the text after it, so the value would either be squeezed into the
marker's box or overlap the following words. Only the SDK lays out text. **Reflow forces the
value into the model.**

### So it is an edit plus a promise

[`previewValues.ts`](src/internal/previewValues.ts) writes the values and records how to undo
each one. The same two rules as the multi-occurrence write apply, for the same reason — every
`setText` shifts the offsets after it, so writes go in descending order within each block, and
the whole pass is one transaction. Each value's final offset is computed *arithmetically*
rather than by searching, because a value like `2026` may also appear as ordinary prose and a
search would find the wrong one. There is a test for exactly that.

Reverting restores the paragraph byte-for-byte, which the tests assert across several
paragraphs and values of differing lengths.

### And here is the half that is not achievable

Press **Check what a save would contain** while values are showing. It serialises the document
the way a host would to store it, and reports:

```
0 of 9 placeholders survived, 9 were baked in as real values.
```

That is not a bug in the demo — it is the requirement failing. Nothing in the API distinguishes
a previewed value from real content: there is no `displayValue`, no field concept, no
content-control access. So "the stored DOCX keeps the placeholder" is not a property of the
document, it is a promise the host has to keep by wrapping **every** path that reads it:

```ts
saveDocument()  saveDocumentJSONString()  exportPDF()  exportDOCX()  export(config)
```

Five paths, each of which must revert, export, and re-apply. Miss one — or add one in a future
version — and a template is silently saved as a filled contract.

### Three more things it costs

**The field list disappears.** The list is built by scanning for `{{ … }}` text, so filling the
template destroys the list of what was filled. The panel keeps showing rows only because it
falls back to *our own record* of the preview — and that record is the only way back to the
template. Lose it (a refresh, a crash) and the markers are gone for good.

**The highlight has to be re-derived from the value.** With the marker gone there is no marker
text to locate, so the bands are recomputed by searching for the *value* at the recorded block.
That mislocates a value which also occurs as prose in the same paragraph, and resolves only the
first block when one key was filled in several.

**Any edit during the preview strands the marker permanently.** Between applying and reverting,
the document is an ordinary editable document holding real values. If the user types in a
filled paragraph, the recorded offsets no longer describe it and the revert refuses:

```
Block 3 was edited while the preview was showing, so the markers cannot be put back
where they came from.
```

Refusing is the best available behaviour — writing markers over text that has moved would
corrupt the template rather than restore it — but the outcome is a template that is now stuck
holding a value, with no way back. A region the SDK owned would simply not have this failure.

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
    caretModel.ts          a shadow caret and caret navigation, both
                           reimplemented because neither is readable   (01 · 1)
    placeholderGuard.ts    keystroke refusal, and where it leaks       (01 · 1)
    previewValues.ts       filling in place, and the promise to undo
                           it that every export path must honour       (01 · 5)
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
(`pnpm test` — 122 tests), which run against a **real captured layout snapshot**
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
