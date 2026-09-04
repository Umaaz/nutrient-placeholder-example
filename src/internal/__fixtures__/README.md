# `ndaLayoutSnapshot.json`

A **real** layout snapshot from the Nutrient Document Authoring SDK, trimmed for use as a test
fixture by `bandGeometry.test.ts` / `snapshotLayout.test.ts`.

|                 |                                                                                   |
| --------------- | --------------------------------------------------------------------------------- |
| SDK version     | `@nutrient-sdk/document-authoring` **1.17.0**                       |
| Source document | `public/fixtures/acme_nda.docx` — a 3-page mutual NDA                |
| Captured by     | a headless-browser capture script in Wordsmith's own repo, not here |
| Captured from   | `documentContext.shadowState.snapshot().shadow.body` in headless Chromium         |

## Shape

`{ sdkVersion, pageDivWidths, body }` — `body` is the SDK's own
`sections[] → pages[] → contentAreas[] → bodyParts[]` tree. `pageDivWidths` is each rendered
page div's `offsetWidth` at capture time (816px for Letter), which is what `pxPerPt` divides by.

## What was trimmed, and what was not

Coordinates, `lineSpacing`, per-glyph `advances` and run text are **untouched** (beyond rounding
every number to 6 decimal places — the SDK's float64 noise tripled the file size and no geometry
depends on those digits). Only whole `bodyParts` were dropped, and every kept part carries its
own absolute `offset`, so dropping siblings does not move anything.

9 of the document's 41 parts are kept, chosen to cover: the title (a heading at a larger font
size), a paragraph with straight-quoted defined terms (`"Agreement"`, `"Effective Date"`),
bracketed single-line placeholder tokens, a heading containing `Confidential Information`, two
paragraphs with a soft-wrapped `Confidential Information` occurrence, and a table part (which
carries `rows` and no `lines`).

Fields the geometry never reads (`faceRuns`, `utf8Counts`, `trPr`, `styledSegments`, `clusters`
trees, `source` beyond `runs[].text`) were dropped at capture time. **Table cell text is not
reachable** by these walkers: a cell nests a whole `contentArea` of its own, and the walkers only
descend `bodyParts`.

## Fidelity check

When it was captured, the trimmed fixture reproduced — to the 0.1px the reference implementation
printed — all 12 rects of a working painted-on-real-text run that fall inside the kept parts.

## Why it is worth having

It is what lets `bandGeometry.test.ts`, `selectionGeometry.test.ts` and `vanishingRule.test.ts`
run in Node with no browser and no SDK, against numbers the SDK actually produced rather than
numbers someone made up. The rect arithmetic in `bandGeometry.ts` is the load-bearing part of
this demo, and this file is how it stays checkable.

## Regenerating

Capture `documentContext.shadowState.snapshot().shadow.body` from a live editor in a headless
browser, alongside each page div's `offsetWidth`, and write
`{ sdkVersion, pageDivWidths, body }`. Two cautions if you write your own capture:

- Round numbers to ~6 decimal places. The SDK's float64 noise tripled the file size and no
  geometry depends on those digits.
- Serialize to full depth. A depth-limited serializer replaces `element.input.advances` and
  `element.input.source.runs` with a placeholder string — which is exactly the two fields the
  geometry needs, and the result looks valid until every rect comes out empty.
