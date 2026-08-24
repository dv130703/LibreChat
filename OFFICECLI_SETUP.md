# OfficeCLI Setup (Word / Excel / PowerPoint MCP Server)

Replaces the removed built-in `create_document` tool. Instead of an in-process
docx/xlsx/pdf generator, agents get Word/Excel/**and PowerPoint** create+edit
through [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI), wired in as a
standard MCP server — no code changes in `packages/api` or `api/` are needed.

Everything below was verified directly against OfficeCLI's README/wiki and
this repo's actual MCP client schema (`packages/data-provider/src/mcp.ts`) —
not assumed from marketing copy. Two things worth knowing up front because
they contradict common claims about this tool:

- **OfficeCLI's MCP server is stdio-only.** There is no `--port`/HTTP mode.
- **It exposes exactly one MCP tool**, `officecli`, with a single `command`
  string parameter — a raw CLI command line passed through verbatim. There is
  no structured per-verb schema, so this does **not** eliminate the kind of
  risk you'd associate with an LLM composing a shell command. Section 5 below
  exists because of this.

---

## 1. Install the binary

Install just the binary — do **not** run `officecli install` or
`officecli mcp <target>` (`claude`/`cursor`/`vscode`/`lmstudio`) on the
server. Those commands auto-detect and rewrite AI-tool configs on the local
machine (meant for a developer's laptop), which is not what you want on a
shared server.

```bash
# Pin an exact version for reproducibility — do not install "latest" blind
npm install -g @officecli/officecli@1.0.144
```

(`brew install officecli`, the `install.sh`/`install.ps1` script, or a manual
download from [Releases](https://github.com/iOfficeAI/OfficeCLI/releases)
work identically — npm is recommended here only because it matches this
repo's existing toolchain and keeps the version pin in one place.)

Verify:

```bash
officecli --version
```

## 2. Pin behavior for a server environment

OfficeCLI checks for updates in the background once a day by default. Turn
that off — you want the server running a version you've deliberately chosen,
not whatever shipped that morning:

```bash
export OFFICECLI_SKIP_UPDATE=1   # preferred: works without a writable ~/.officecli/config.json
# or, equivalently, persisted to ~/.officecli/config.json:
officecli config autoUpdate false
```

Optionally capture `officecli --output-schema-crc` for the pinned version —
it fingerprints the whole property schema. Re-run it after any future binary
upgrade; an unchanged CRC means the documented property surface is
byte-identical and safe to upgrade without re-verifying prompts/tests.

## 3. Choose an operating mode

By default OfficeCLI runs in **resident mode**: the first command on a file
spawns a background process that keeps the document open in memory (fast,
but stateful, with idle timeouts and named-pipe IPC). OfficeCLI's own docs
describe the MCP server as running "one instance per AI client session" —
in this deployment, LibreChat's backend *is* that one client, shared across
every concurrent user and conversation. Until you've load-tested it, prefer
the stateless mode so one user's in-flight edit can't interact with another's:

```bash
export OFFICECLI_NO_AUTO_RESIDENT=1
```

Each command then does a full open → modify → save → close cycle. Slower per
call, but no shared in-memory state between requests. Revisit this only if
profiling shows it's a real bottleneck.

## 4. Register it as an MCP server

If you don't have a `librechat.yaml` yet, copy the example first:
`cp librechat.example.yaml librechat.yaml`.

Add, under the top-level `mcpServers:` key:

```yaml
mcpServers:
  officecli:
    type: stdio
    command: officecli
    args:
      - mcp
    env:
      OFFICECLI_SKIP_UPDATE: '1'
      OFFICECLI_NO_AUTO_RESIDENT: '1'
    timeout: 120000 # generous — pptx/xlsx rendering can be slow on first call
    stderr: pipe # so OfficeCLI's own logs land in the server log, not swallowed
```

LibreChat spawns and owns this process itself (`command`/`args`) — you are
not standing up a separate long-running server and pointing LibreChat at an
endpoint.

Restart the backend and confirm the server connects — either in the backend
log at startup, or via the MCP server picker in the agent Tools panel (gated
by the `mcpServers` role permission, same as any other MCP server).

## 5. Filesystem containment — this is on you, not OfficeCLI

OfficeCLI has no documented working-directory restriction, path allowlist, or
sandbox flag of its own. LibreChat's stdio MCP transport has no `cwd` field
either (checked `packages/api/src/mcp/`) — the child process simply inherits
whatever directory the LibreChat backend process itself was started from. So
there is no built-in boundary stopping the model from asking OfficeCLI to
read or write an absolute path anywhere the OS-level user can reach.

Two layers, and you need both:

- **Soft (prompt-level):** tell the agent, via its instructions, to only ever
  operate on paths under one fixed directory (e.g.
  `/srv/librechat/office-docs/`). This is necessary so generated files land
  somewhere your file-attachment pipeline actually looks — but it is not a
  security boundary; a sufficiently adversarial or confused model can still
  ask for `../../etc/whatever`.
- **Hard (OS-level):** since this project runs without Docker, enforce the
  boundary with a dedicated low-privilege OS user or a lightweight sandbox
  around just this one subprocess, e.g.:

  ```yaml
  mcpServers:
    officecli:
      type: stdio
      command: firejail
      args:
        - '--private=/srv/librechat/office-docs'
        - officecli
        - mcp
      # ...env/timeout/stderr as above
  ```

  (or `runuser -u officecli-svc --` / `setpriv` with a user whose filesystem
  permissions are limited to that one directory tree — whichever fits your
  existing ops setup). Don't skip this step just because MCP "feels" sandboxed
  by protocol — for this specific tool it isn't.

## 6. Agent-facing guidance

The old `create_document` tool injected authoring rules via
`buildDocumentGuidanceContext` (now removed). You don't need to rebuild that:
OfficeCLI's own MCP tool description already carries a "delivery gate" —
it tells the model to run `validate`, `view issues`, and a `view screenshot`
visual check before treating a document as finished. If you want
house-specific rules on top of that (e.g. "always save under
`/srv/librechat/office-docs/{conversationId}/"`), add them to the agent's
instructions field rather than building a new context-injection layer.

## 7. Verify end-to-end

1. `npm run backend:dev`, confirm the `officecli` MCP server connects.
2. In a test conversation, enable the `officecli` MCP tool on an agent and
   ask it to create a small `.pptx`.
3. Confirm the file was written only inside the scoped directory from step 5.
4. Confirm no auto-update notice appears in the piped stderr log after a
   command (step 2 working as expected).

## Known limitations (tell whoever uses this)

- The MCP tool is one opaque `command: string` parameter, not typed
  per-verb arguments — treat it like code-execution tooling in terms of
  trust, not like a normal typed function call.
- Stdio only — no HTTP/SSE mode, regardless of what other write-ups claim.
- No built-in sandbox — section 5 is mandatory, not optional hardening.
- Resident mode (if re-enabled) is shared across all concurrent LibreChat
  users hitting this one MCP server process, not per-conversation.

## References

- OfficeCLI: https://github.com/iOfficeAI/OfficeCLI (README + wiki:
  `command-mcp`, `command-reference`, `command-install`)
- This repo's MCP schema: [`packages/data-provider/src/mcp.ts`](packages/data-provider/src/mcp.ts)
- Example MCP server entries: [`librechat.example.yaml`](librechat.example.yaml) (search `mcpServers`)
