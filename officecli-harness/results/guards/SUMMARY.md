# Guards arm results — PARTIAL (5/20 trials)

This run was stopped deliberately after 5 trials (all 4 `status-memo` +
`edit-existing-r0`) rather than let the remaining 15 run unattended a second
time. What's here is real, completed data — not a projection — for exactly
the two guards that were added on top of the `officecli-control-baseline`
tag:

1. `ParseHelpers.ValidateNoMarkdownListMarker` — rejects literal `"1. "`/`"- "`/
   `"## "` markers at the start of `.docx` paragraph text in `add_element`
   and `edit_text`, with a corrective `Suggestion` (use `listStyle`/`style`
   instead).
2. Table creation now bolds row 0 by default when `rows > 1` (opt out via
   `properties.headerRow = "false"`).

## What ran

| Trial | Call validity | Markdown-leak | Artifact pass |
|---|---|---|---|
| status-memo-r0 | 9/9 | clean | pass |
| status-memo-r1 | 14/14 | clean | pass |
| status-memo-r2 | 12/12 | **clean** (failed in control) | pass |
| status-memo-r3 | 13/13 | **clean** (failed in control) | pass |
| edit-existing-r0 | 2/2 | clean | pass |

**Guard 1 result: 4/4 clean, including both trials that failed in control.**
Call validity stayed at 100% across all 4 — the guard's rejection did not
cause retry storms or degrade the model's ability to complete the task; it
corrected and moved on. This is the strongest possible signal a 4-trial
sample can give for this specific defect, though n=4 (rather than a fresh
20) means it should still be read as "the mechanism works," not "guaranteed
0% forever."

**Guard 2 (table header bolding) was not exercised by this partial run** —
`table-insertion` never got scheduled before the stop. It was, however,
verified directly and separately (see `officecli-harness/results/control/SUMMARY.md`'s
sibling smoke test in the session transcript): a table created via
`add_element(type="table", properties={data: "..."})` with 3 rows produced
`headerBold: true` where the same call pre-guard produced `headerBold: false`
in 3 of 4 control trials. Direct evidence the default fires; not the same as
a 4-trial rate under real model variance.

**`heading-hierarchy` and `underspecified` did not run in this arm** — no
data either way. Neither guard added targets those failure modes (heading
hierarchy was already 4/4 in control; underspecified's fabrication problem
is a missing-capability issue — see the `ask_user_question`/HITL finding —
not something either guard touches).

## Decision on the docx skill (per OFFICECLI_HARNESS.md step 8)

Per the plan agreed before running this: *"If markdown leak goes to 0/4 and
tables to 4/4 deterministically, the skill's remaining value is the
L1→L2→L3 ladder — and heading-hierarchy and edit-existing already scored 4/4
without it. That's a thin case for 2k tokens."*

Markdown-leak: 4/4 clean, confirmed by real trials. Table header: confirmed
by direct call, not by a 4-trial rate, but the mechanism is unconditional
(not model-dependent) so there's no real-variance question to resolve the
way there was for markdown-leak. `heading-hierarchy` and `edit-existing`
were already 4/4 in the control baseline with no skill involved.

**Recommendation: do not write the officecli-docx skill transformation right
now.** The two mechanical defects that justified it are handled at the tool
level, for free in the token budget, deterministically. The remaining
open defect (`underspecified` → fabrication) is a missing-capability
problem (`ask_user_question` not wired), which a skill's prose cannot fix
either way — no combination of instructions makes a tool available that
isn't in the agent's tool list. Revisit the skill only if a future scenario
surfaces a defect that's genuinely about *knowledge* (e.g. correct APA
citation formatting, financial model structure) rather than *mechanics* —
that's the class of problem prose actually helps with.
