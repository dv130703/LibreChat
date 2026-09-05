#!/usr/bin/env bash
# Confines one user's OfficeCLI MCP server process to its own workspace
# directory. Neither LibreChat's MCP config (no `cwd` option on the spawned
# stdio process) nor OfficeCLI itself (no documented --workspace/--root flag)
# provide filesystem confinement on their own, so bubblewrap (bwrap) is the
# real security boundary in production — see the exec at the bottom.
#
# Local/single-developer fallback: if `bwrap` isn't installed (e.g.
# `sudo apt install bubblewrap` hasn't been run on this box yet), this script
# still confines the process to the workspace via `cd` alone — no filesystem
# jail, just working-directory scoping. That's acceptable for one developer
# testing on their own machine, but MUST NOT be relied on for a real
# multi-user deployment: install bubblewrap and let the exec below take over
# before going anywhere near production.
#
# Deploy this file to the path referenced by librechat.yaml's
# `mcpServers.officecli.command` and `chmod +x` it.
#
# Retention: files left in a user's workspace after LibreChat persists them
# as chat attachments are deleted automatically (see
# api/server/services/Files/Office/process.js). This wrapper does not do its
# own retention sweep — pair it with an ops-level cron/systemd-timer job that
# removes anything older than e.g. 24h under WORKSPACE_ROOT, in case a file
# is ever left behind by a failed or aborted tool call.
set -euo pipefail

## This deployment runs a custom-built fork (vendor/officecli in the LibreChat
## repo) rather than the upstream npm package: the fork replaces the original
## single generic "officecli" MCP tool with granular, Anthropic-style tools
## (create_document, edit_text, set_properties, ...) built on the official
## ModelContextProtocol C# SDK. Override OFFICECLI_BIN to point at a different
## build (e.g. a `dotnet publish` output) without editing this script.
OFFICECLI_BIN="${OFFICECLI_BIN:-/home/daniel/LibreChat/vendor/officecli/src/officecli/bin/Release/net10.0/linux-x64/officecli}"

## Defaults live under $HOME so this works without root/pre-provisioned
## directories on a local dev box. Production should set
## OFFICECLI_WORKSPACE_ROOT/OFFICECLI_TEMPLATES_DIR (e.g. to /data/office/...)
## in the LibreChat backend's own environment — this script inherits them
## automatically since it's spawned as its child process, and
## api/server/controllers/agents/callbacks.js reads the same two variables
## for its mtime-diff file detection, so they MUST stay in agreement.
WORKSPACE_ROOT="${OFFICECLI_WORKSPACE_ROOT:-$HOME/.local/share/officecli/users}"
TEMPLATES_DIR="${OFFICECLI_TEMPLATES_DIR:-$HOME/.local/share/officecli/templates}"

if [[ $# -lt 1 || -z "$1" ]]; then
  echo "mcp-wrapper.sh: missing required user id argument" >&2
  exit 1
fi
USER_ID="$1"

WORKSPACE="${WORKSPACE_ROOT}/${USER_ID}"
mkdir -p "$WORKSPACE" "$TEMPLATES_DIR"

if ! command -v bwrap >/dev/null 2>&1; then
  echo "mcp-wrapper.sh: bubblewrap (bwrap) not found — running WITHOUT a filesystem jail (cd-only). Install bubblewrap before any multi-user deployment." >&2
  cd "$WORKSPACE"
  exec "$OFFICECLI_BIN" mcp
fi

exec bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --bind "$WORKSPACE" "$WORKSPACE" \
  --ro-bind "$TEMPLATES_DIR" "$TEMPLATES_DIR" \
  --proc /proc \
  --dev /dev \
  --chdir "$WORKSPACE" \
  --unshare-net \
  --die-with-parent \
  --ro-bind "$OFFICECLI_BIN" "$OFFICECLI_BIN" \
  "$OFFICECLI_BIN" mcp
