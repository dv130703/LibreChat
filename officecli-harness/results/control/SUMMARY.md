# Control arm results — skills_enabled: false

See `_header.json` for full provenance (git_head, git_dirty=true, diff_hash
not yet recorded — see note below). Run via `officecli-harness/run.js`
directly against Ollama + the officecli MCP wrapper (LibreChat backend not
involved; axis 2 is a proxy — see `axis2_note` in the header).

`prompt_overhead_tokens` (system + 11 tool schemas, empty conversation, measured):
**3049** — out of `num_ctx=8192`, leaving ~5143 for the actual conversation.

## Aggregate

| Scenario | Delivered | Clarification | Artifact pass | Call validity |
|---|---|---|---|---|
| status-memo | 4/4 | 0/4 | **2/4** | 50/55 (90.9%) |
| edit-existing | 4/4 | 0/4 | 4/4 | 18/19 (94.7%) |
| table-insertion | 4/4 | 0/4 | **1/4** | 42/42 (100%) |
| heading-hierarchy | 4/4 | 0/4 | 4/4 | 36/40 (90.0%) |
| underspecified | 4/4 | **0/4** | n/a (by design) | 32/32 (100%) |
| **Overall** | 20/20 | 0/20 | 7/16 applicable | **178/188 (94.7%)** |

Context-limit hits: 2/20 (`status-memo-r2`, `table-insertion-r2`).

## What's actually wrong (axis 3, not axis 1)

Call validity is high across the board — the typed tool surface is doing its
job. The real defects are all in artifact correctness, and axis 1 would have
missed every one of them:

1. **Markdown-leak into list text is real and non-deterministic**, not fixed
   by the typed surface. 2 of 4 `status-memo` trials wrote literal `"1. "`,
   `"2. "`, `"•"` characters into the paragraph text itself — in one case
   (`r2`) *while simultaneously* setting `listStyle: "bullet"` as a real
   property, i.e. the model applied both the correct mechanism and the
   markdown habit at once. This is the same defect class as the original
   broken-memo screenshot, reproducing today, at ~50%, under an otherwise
   well-behaved tool surface with `skills_enabled: false`.
2. **Table header rows are essentially never bolded without being told to.**
   3 of 4 `table-insertion` trials produced a structurally fine table with an
   unstyled header row. Single most consistent failure in this run.
3. **Stale/hallucinated anchor paths cause real tool errors, but the model
   usually recovers.** `status-memo-r2` and `heading-hierarchy-r2` both
   referenced `paraId`s or parent paths that didn't exist or were structurally
   invalid (e.g. trying to nest a paragraph inside a paragraph). The server's
   error messages are good — self-correcting-friendly, naming exactly what's
   wrong — and the model used them to recover in both cases (`heading-hierarchy-r2`
   still passed its artifact check). The cost shows up indirectly:
   error-recovery loops are what actually drove both context-limit hits, not
   raw scenario complexity.
4. **The model never asks a clarifying question.** 0/4 `underspecified`
   trials produced anything but fabricated Q3 figures delivered as fact.
   Whether a skill's routing guidance changes this is exactly what this
   scenario exists to watch in the treatment arm.

## Known gaps in this control run

- `diff_hash` was not computed for this exact run (only `git_dirty: true` was
  recorded) — if this control needs to be cited later, recompute it against
  the current tree state before trusting `git_head` alone.
- Axis 2 is a proxy (file written to workspace), not verified through the
  real `processOfficeCliOutput`/`claimCodeFile` promotion pipeline.
- The harness's own `checks.js` is a first pass — e.g. `checkHeadingStyle`'s
  "looks like a heading" heuristic (bold + short + large font, no `Heading`
  style) never fired in this run; it's untested against a real direct-formatting
  case and should be treated as unverified until one shows up.
