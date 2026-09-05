# OfficeCLI Integration — Architecture

One-page orientation for anyone inheriting this feature. For setup steps see
`OFFICECLI_SETUP.md`; for the quality/skill-vs-guards decision process see
`OFFICECLI_HARNESS.md`; for live system health see `officecli-harness/doctor.js`.

## The shape, in one picture

```
┌── CONTROL PLANE ── model ↔ MCP ───────────────────────────────────┐
│  11 typed tools (create_document, add_element, edit_text, ...).   │
│  Model sees relative filenames only, never an absolute path.      │
│  vendor/officecli/src/officecli/Mcp/Tools/*.cs                    │
└─────────────────────────────────────────────────────────────────┘
┌── DATA/DELIVERY PLANE ── workspace + mtime-diff bridge ───────────┐
│  Each user gets one persistent, bubblewrap-jailed workspace dir   │
│  (config/officecli/mcp-wrapper.sh). officecli reads/writes files  │
│  there directly — no network hop, no JWT, no separate service.    │
│  After every tool call, packages/api/src/files/office/detect.ts   │
│  diffs the workspace's file mtimes; a changed .docx/.xlsx/.pptx   │
│  gets promoted through api/server/services/Files/Office/          │
│  process.js into a real Mongo File doc (context: execute_code,    │
│  reusing the Code-Interpreter output pipeline) so it shows up as  │
│  a normal chat attachment.                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Why not the network-sidecar design you might expect** (a Python bridge,
JWT-authenticated file fetch/deliver routes, opaque `doc` handles): that
shape exists to solve a problem this deployment doesn't have. OfficeCLI here
is a *vendored, locally-built binary* running as a stdio subprocess on the
same host as the LibreChat backend — there's no separate service to bridge
to. The workspace-directory design reuses LibreChat's existing file-storage
and Code-Interpreter-output plumbing instead of building a parallel one.
Don't reach for a sidecar/JWT design unless officecli ever becomes a genuinely
remote service — it currently is not one.

## The one invariant that matters

**The model never sees an absolute path, and can never write outside its own
workspace.** Two independent layers enforce this — treat both as load-bearing,
not redundant:

- **OS-level**: `bubblewrap` binds only the user's workspace dir + templates
  dir into the sandboxed process (`config/officecli/mcp-wrapper.sh`). Falls
  back to `cd`-only confinement (no real jail) if `bwrap` isn't installed —
  fine for solo dev, **not** for any multi-user deployment; `office-doctor`
  flags this.
- **Application-level**: `resolveWorkspacePath` (`packages/api/src/files/office/detect.ts`)
  and `PathGuard` (C# side, `vendor/officecli/.../PathGuard.cs`) both reject
  any path that resolves outside the workspace root, tested in
  `detect.spec.ts`.

If you're reviewing a change to either plane and it introduces a way for a
path, byte, or handle to cross a plane boundary in a new way, that's the
question to ask before merging it.

## Guards over grounding — the load-bearing decision

Two real defects were measured against a real control-run baseline
(`officecli-harness/results/control/`, tagged `officecli-control-baseline`)
and fixed **mechanically in the C# tool layer**, not via a skill or more
prose:

- `ParseHelpers.ValidateNoMarkdownListMarker` — rejects literal `"1. "`/`"- "`
  markers in paragraph text (measured ~50% occurrence, now 0/4 on retest).
- Default header-row bolding in table creation (measured ~75% miss rate).
- `ParseHelpers.ValidateNoDirectFormattedHeading` — rejects bold+large-size
  masquerading as a heading. Added as defense-in-depth; no measured
  occurrence yet, unlike the other two.

**No skill is wired into `./skill/`.** `DEPLOYMENT_SKILLS_DIR` and
`skills_enabled` both work and were verified; the 10 skill files vendored at
`vendor/officecli/skills/*` are untouched upstream content, written in the
old single-string-CLI syntax (`officecli add file.docx --prop x=y`) that
**does not match this fork's typed tool names**. Wiring any of them into
`./skill/` without transforming them first (per `OFFICECLI_HARNESS.md` §4.2)
would hand the model detailed instructions for a tool surface it can't call.
Treat every file under `vendor/officecli/skills/` as inert reference
material, not a deployable skill, until it's been through that transform.

## Known gaps (not yet closed)

- **No blocking delivery gate.** `validate_document`/`view_issues` exist as
  tools the model *can* call; nothing requires it to call them before a
  file is promoted as an attachment. What now exists: every promoted file
  is automatically re-validated server-side (`processOfficeCliOutput` shells
  out to `officecli validate --json`) and the result is attached to the
  File's `metadata.officeCliValid`/`officeCliValidationMessage` — so an
  invalid delivery is visible after the fact, even though it still isn't
  prevented. Making it a hard, fail-closed gate would mean tracking
  per-turn validation state across tool calls, a bigger and riskier change
  than this session's scope.
- **`ask_user_question`** is wired for the one agent using officecli tools,
  but not verified end-to-end (needs a real LibreChat chat session, not the
  harness's direct Ollama+MCP route, to observe).
- Retention sweep (`config/officecli/retention-sweep.sh`) is written and
  tested but not installed as a live cron/systemd job — see the script's own
  header for the one-line install.
- No SFO template/house-style library (`doc_merge`-equivalent) — every
  document is still authored element-by-element. Legitimate future work if a
  recurring branded-document need shows up; not yet justified by evidence.
