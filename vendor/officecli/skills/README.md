# Do not wire these into `./skill/` as-is

These 10 skill directories are **untouched upstream OfficeCLI content**,
written for upstream's single-string CLI tool (`officecli add file.docx
--prop x=y`). This fork's actual MCP surface is 11 granular typed tools
(`add_element`, `set_properties`, `edit_text`, ...) — see
`vendor/officecli/src/officecli/Mcp/Tools/`. The syntax in these files does
not match that surface.

Copying any of these into the repo root's `./skill/` (the directory
LibreChat's Agent Skills loader actually reads —
`packages/api/src/skills/deployment.ts`) without transforming the CLI
invocations to the real tool names/JSON params first will hand the model
detailed, confident instructions for calling tools that don't exist. See
`OFFICECLI_HARNESS.md` §4.2 ("Transform the skill, do not copy it") for the
transformation rules, and `officecli-harness/results/guards/SUMMARY.md` for
why no skill is currently wired at all — the two defects that originally
motivated one turned out to be fixable mechanically in the tool layer
instead, at zero token cost.

If you do transform and wire one of these later: measure it against a fresh
control run first (`officecli-harness/`), the same way the guards were
validated. Don't assume a skill helps just because it looks thorough.
