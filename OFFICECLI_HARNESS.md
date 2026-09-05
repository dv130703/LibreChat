# OfficeCLI Skill-Grounding Regression Harness

Formalizes the protocol used to decide whether wiring an OfficeCLI skill into
`./skill/` (the directory LibreChat's Agent Skills loader actually reads —
see `skill/README.md` and `packages/api/src/skills/deployment.ts`) helps or
hurts output quality on this deployment's local model.

**Outcome (see `officecli-harness/results/`):** the control run (tag
`officecli-control-baseline`) found call validity already high (94.7%) and
both real axis-3 defects — markdown-leak in lists, unbolded table headers —
mechanical rather than knowledge gaps. Both were fixed at the tool level
(`ParseHelpers.ValidateNoMarkdownListMarker`, default header-row bolding in
`WordHandler.Add.Table.cs`) instead of via a skill; a partial guards re-run
confirmed the markdown-leak fix (4/4 clean, including both control failures).
**The officecli-docx skill transformation was not written** — see
`officecli-harness/results/guards/SUMMARY.md` for the reasoning. The
protocol below remains the reference for any future skill-vs-no-skill
decision on this deployment.

## Why this file exists

An earlier session measured qwen3-14b-8k's tool-call reliability dropping
from 10/10 to 4/10 under a verbose `serverInstructions` block (see the
comment at `librechat.yaml:370-378`). That number is real but its only
artifact is a one-line comment — no saved prompts, no scoring method, no
seeds. It is not reconstructable and should not be faked back into existence.
Treat it as a **directional hypothesis** ("prose volume hurts this model's
tool-call reliability"), not a baseline to compare against. Every comparison
from here forward runs its own control, on the same HEAD, in the same
sitting.

## Fixture header — record this for every run

```yaml
date: # ISO date
git_head: # `git rev-parse HEAD`
git_dirty: # true/false — this repo has substantial uncommitted work; see note below
diff_hash: # sha256 of `git diff HEAD` (+ untracked files under vendor/officecli, api/server/services/Files/Office, packages/api/src/files/office, config/officecli) — required whenever git_dirty is true
model_tag: qwen3-14b-8k:latest
quant: Q4_K_M
num_ctx: 8192              # see VRAM note below — do not change without re-recording
kv_cache_type: q8_0         # OLLAMA_KV_CACHE_TYPE, already active system-wide
temperature: 0.3            # agent's actual production value — do not override to something more deterministic; we're measuring production behavior
seed: # per-trial, see below
skills_enabled_on_agent: # true/false for this run — control is always false, unconditionally (see Procedure)
skill_dir_contents: # list what's actually in ./skill/ at run time, or "empty"
prompt_overhead_tokens: # system + 11 tool schemas + serverInstructions, empty conversation — measure once per arm, see Procedure
```

**On `git_dirty`**: `git rev-parse HEAD` on a dirty tree records a SHA that
doesn't describe what actually ran — this repo currently has most of the
OfficeCLI integration uncommitted. Don't treat `git_head` alone as sufficient
provenance while that's true. Either commit before trial 1 (cleanest, but
that's the user's call, not this harness's), or record `git_dirty: true` plus
`diff_hash` so the exact tree state is at least fingerprinted and diffable
later even if not committed. A reproducible-in-principle, not-in-fact control
is the same failure class the original 10/10→4/10 comment was.

**VRAM note (why num_ctx is 8192 and isn't moving without hardware changes):**
this host is a single RTX 4070 SUPER (12282 MiB total, ~1800 MiB permanently
held by the WSL2 GPU compositor, leaving ~10480 MiB for Ollama). qwen3:14b at
Q4_K_M is ~8845 MiB of weights. KV cache with the already-active
`OLLAMA_KV_CACHE_TYPE=q8_0` costs ~80 KiB/token (`2 × 40 layers × 8 kv_heads
× 128 head_dim × 1 byte`, i.e. half the fp16 rate). At 8192 tokens that's
~640 MiB; add ~550 MiB compute-graph overhead and full GPU offload needs
~10035 MiB — a ~450 MiB margin under the ~10480 MiB available. At 16384
tokens the KV cache alone roughly doubles to ~1280 MiB, pushing total need to
~10675 MiB — past what's free, which means partial CPU offload and a real
latency hit, not a free win. Flash attention and KV quantization — the two
usual levers — are already both on. **8k is not an inherited default; it is
within ~450 MiB of this card's practical ceiling for this model.** Getting to
16k+ requires a smaller/more aggressive quant, a smaller model, accepting
CPU-offload latency, or more VRAM — not a config-line change. This is why the
docx skill transformation target is ~2k tokens, not ~8k: the reference
material duplicates what the 11 tool schemas already put in context every
turn, and deleting that duplication is the actual lever, not the window.

## Scoring — three independent axes, never collapse to one number

The original 10/10→4/10 almost certainly measured axis 1 alone. Axis 3 is
what a skill is actually *for*, and a skill can plausibly lower axis 1 (more
context → more drift) while raising axis 3. Score and report all three
separately per trial.

1. **Call validity** = valid tool calls / total tool calls in the trial.
   Valid means: registered tool name (one of the 11
   `*_mcp_officecli` tools), parameters parse against that tool's schema,
   all required params present, and any element/path reference in the call
   resolves against the document's actual current structure.
2. **Task completion** (binary, with a third category — see scenario 5) —
   did a file get produced and actually promoted into a chat attachment via
   `processOfficeCliOutput`/`claimCodeFile` (i.e. it shows up as a real
   `file_id`, not just left in the workspace).
3. **Artifact correctness** (binary + notes) — structural assertions on the
   delivered file:
   - no literal markdown leaking into run text (`- `, `* `, `# `, `**`)
   - headings use named styles, not direct character formatting
   - no placeholder residue (`TODO`, `{{`, `Lorem`, `XXX`, `[insert`)
   - (scenario-specific assertions below)

   **Denominator is delivered files, not 20.** A trial with no completion
   has no artifact to score — excluding it from axis 3's denominator, not
   counting it as a correctness failure, is what keeps axis 2 and axis 3
   independent. A treatment that delivers fewer files but scores higher on
   the ones it does deliver should read as "more conservative, more
   correct when it commits" — not as flat or worse.

**Per-call/per-trial instrumentation (in addition to the three axes):**
- `prompt_tokens` for every model call in the trial (from the Ollama
  response's `prompt_eval_count` or equivalent).
- `hit_context_limit` (bool) per trial — true if any call in the trial's
  `prompt_tokens` came within ~200 tokens of `num_ctx`, or if the response
  was visibly truncated/cut off mid-tool-call. At 8192 tokens with 11 tool
  schemas already resident, longer scenarios can exhaust the window
  mid-task, and that failure is indistinguishable from "the model got
  confused" unless measured directly. The treatment arm adds ~2k tokens to
  an already-tight budget, so truncation failures will concentrate there —
  attributing them to skill quality instead of arithmetic is the specific
  wrong conclusion this field exists to prevent.

## Scenarios (5) × 4 runs = 20 trials

Derived from real failure modes, not synthetic ones:

1. **Status memo, verbatim** — the exact prompt that produced the original
   broken memo screenshot. Artifact check: heading styles, no `"- "` bullet
   leakage into paragraph runs.
2. **Edit to a user-supplied .docx** — attach an existing document, ask for
   a targeted edit (e.g. "update the budget section"). Artifact check:
   **semantic, not byte-level** — extracted text and style assignments for
   unrelated sections unchanged. Any OOXML round-trip through a DOM editor
   rewrites the package (attribute ordering, rel renumbering, zip entry
   order/timestamps move even with zero semantic change), so a
   byte-identical assertion fails every trial in both arms and reads as a
   catastrophic regression that isn't real. Compare parsed structure only.
3. **Table insertion** — ask for a table with specific columns/rows into an
   existing or new document. Artifact check: correct row/column count,
   header row styled distinctly.
4. **Heading hierarchy** — a document requiring H1/H2/H3 nesting (e.g. a
   report with sections and subsections). Artifact check: style names in
   the OOXML match the visual hierarchy (no skipped levels, no direct
   formatting standing in for a missed style).
5. **Underspecified request** — deliberately vague ("write something up
   about the Q3 numbers"). No artifact-correctness assertions; this
   scenario exists to watch call validity and completion under ambiguity,
   where a skill's trigger/routing guidance matters most. **Task completion
   has a third outcome here**: `clarification_requested`. If the model asks
   what Q3 numbers to use rather than inventing figures, that is correct
   behavior, not a completion failure — scoring it as a failure penalizes
   exactly the behavior we want. Record completion as one of
   `{delivered, clarification_requested, failed}`, and don't fold
   `clarification_requested` into the failure count for this scenario in
   either arm.

Per trial: fix `seed` to a distinct value per trial index (e.g.
`scenario_index * 100 + run_index`), used identically in both the control
and treatment run of that trial. Use the agent's real production
`temperature` (0.3) — don't substitute a more deterministic value; we're
measuring production behavior, not an idealized best case.

**Paired design — use it, don't just note it.** Fixing seed-by-trial-index
across both arms means control and treatment run the *same seed on the same
scenario*, not independent samples. That's a paired design, and it's
substantially more sensitive at n=20 than comparing two aggregate
proportions: for each binary axis, tabulate the four outcomes per matched
pair (pass→pass, pass→fail, fail→pass, fail→fail) and read the discordant
pairs (pass→fail vs fail→pass) as the actual signal — a McNemar-style
reading — rather than just the marginal rates. Report both, but the
discordant-pair count is what tells you whether the skill moved anything,
since two runs with identical marginal proportions can still show a real,
one-directional effect once paired.

## Procedure

1. **Control, skills off, current HEAD.** Set `skills_enabled: false` on
   the "Word Document Writer" agent for this run, unconditionally — not
   "if in doubt." This whole exercise has been about replacing inference
   about prompt state with observation of it; leaving one inferred fallback
   ("probably fine since `./skill/` is empty anyway") back in the procedure
   reintroduces the exact ambiguity that got removed. Record `git_head`,
   `git_dirty`, and `diff_hash` (see header) for this exact run — commit
   first if that's been decided, otherwise record the diff fingerprint.
2. **Measure `prompt_overhead_tokens` once for this arm**: send one call on
   an empty conversation (system prompt + the 11 tool schemas +
   `serverInstructions`, no user turn yet) and read `prompt_tokens` off the
   response. This is free — it's the first call of trial 1 — and it turns
   the ~2k transformation target from an estimate into a measured number
   once repeated in the treatment arm.
3. **Reset the workspace before every trial.** Nothing currently tears down
   the per-user bubblewrap workspace between trials — trial N+1 starts in a
   directory still containing trial N's output files. That leaves stale
   files in scope for `detect.ts`'s mtime-diff, and a promotion could attach
   the wrong document to the wrong trial, which would score as a false axis-2
   pass. Before each trial: `rm -rf` the contents of that user's
   `OFFICECLI_WORKSPACE_ROOT/<user_id>/` (not the directory itself — leave
   `TEMPLATES_DIR` untouched), and record that the teardown ran. This
   procedure also functions as a live check on the open item below —
   watch whether a leftover scratch file from a prior trial ever gets
   promoted despite the reset (would indicate the detector is watching a
   wider window than intended, not just that the harness forgot to clean up).
4. Run all 20 trials, recording per-trial: scenario, seed, workspace-reset
   confirmation, raw tool-call sequence, `prompt_tokens` per call,
   `hit_context_limit`, produced `file_id` (or none / `clarification_requested`
   for scenario 5), and the three axis scores.
5. **Transform `officecli-docx` only** (target ~2k tokens — drop the
   parameter/property reference, since the 11 tool schemas already carry
   that; keep the L1 read → L2 DOM edit → L3 raw XML ladder and the
   delivery gate, harvested from the base `officecli/SKILL.md` per the
   routing note below). Wire it alone into `./skill/officecli-docx/`.
6. Re-run all 20 trials (same seeds, same scenarios, workspace reset before
   each) with `skills_enabled: true` and the transformed docx skill present.
   Re-measure `prompt_overhead_tokens` for this arm too.
7. Compare per-axis using the paired reading above — discordant pairs
   first, marginal rates second — not as one collapsed number.
8. Only expand to a second skill (xlsx or pptx) if docx holds or improves
   on axis 3 without an unacceptable axis-1 regression. Ten skills at once,
   as they exist untransformed today, is not evaluable — a regression
   can't be attributed to any one of them.

## Routing note — the base `officecli/SKILL.md`

Its frontmatter description ("...using the officecli CLI tool") is generic
and upstream-flavored next to the other nine, which are specific and
trigger-worded. The nine format/scene skills already self-route via their
own frontmatter and declare their inheritance explicitly (e.g.
`officecli-pitch-deck` says it's "a scene layer on top of officecli-pptx").
That makes the base skill mostly redundant as a standalone entry. Don't wire
it on its own — harvest its L1→L2→L3 strategy paragraph and delivery-gate
description into `officecli-docx`'s header (and, later, into xlsx/pptx's)
instead, and leave the base skill file out of `./skill/`.

## Known-open items surfaced during Phase 0 (not yet in scope here)

- `detect.ts`'s mtime-diff is tested for sub-second granularity and path
  traversal (`detect.spec.ts`), but not for: (a) an in-place write that
  preserves mtime, (b) a scratch file with an office extension the model
  created for its own reference getting promoted as if it were a
  deliverable. Worth a scenario addition once OfficeCLI's actual write
  behavior on this point is confirmed.
