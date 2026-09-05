#!/usr/bin/env node
/**
 * office-doctor — one command that answers "is the OfficeCLI integration
 * actually healthy right now", tailored to this deployment's real
 * architecture (vendored C# fork + bubblewrap-jailed per-user workspace +
 * mtime-diff file bridge), not the generic HTTP-data-plane version. Run
 * after any change to the binary, wrapper, workspace layout, or Ollama
 * config — and hand this file to whoever inherits this integration.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const REPO_ROOT = '/home/daniel/LibreChat';
const OFFICECLI_BIN = path.join(REPO_ROOT, 'vendor/officecli/src/officecli/bin/Release/net10.0/linux-x64/officecli');
const WRAPPER = path.join(REPO_ROOT, 'config/officecli/mcp-wrapper.sh');
const WORKSPACE_ROOT = path.join(os.homedir(), '.local/share/officecli/users');
const STALE_DAYS_THRESHOLD = 1; // mcp-wrapper.sh's own comment says pair it with a 24h sweep

const lines = [];
const warnings = [];
function report(label, value, warn) {
  lines.push(`${label.padEnd(28)}: ${value}`);
  if (warn) warnings.push(`${label}: ${warn}`);
}
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch (err) { return null; }
}

async function main() {
  // --- git provenance ---
  const head = sh(`git -C ${REPO_ROOT} rev-parse HEAD`) || 'unknown';
  const dirty = sh(`git -C ${REPO_ROOT} status --porcelain`);
  report('git HEAD', dirty ? `${head} (dirty)` : head, dirty ? 'uncommitted changes present — see git status' : null);

  // --- binary ---
  const binExists = fs.existsSync(OFFICECLI_BIN);
  if (!binExists) {
    report('officecli binary', 'MISSING at ' + OFFICECLI_BIN, 'build it: cd vendor/officecli/src/officecli && dotnet build -c Release');
  } else {
    const version = sh(`${OFFICECLI_BIN} --version`) || 'unknown';
    const binMtime = fs.statSync(OFFICECLI_BIN).mtime;
    const srcMtime = sh(`find ${REPO_ROOT}/vendor/officecli/src/officecli -name '*.cs' -newer ${OFFICECLI_BIN} | head -1`);
    report('officecli binary', `present, v${version}${srcMtime ? '' : ''}`,
      srcMtime ? `binary is STALE — .cs source newer than the build (e.g. ${srcMtime}); rebuild` : null);
  }

  // --- ICU / globalization ---
  const icuInstalled = !!sh("ldconfig -p | grep -i libicu");
  const invariantSet = process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT;
  report('ICU', icuInstalled ? 'installed' : 'NOT installed', icuInstalled ? null : 'set DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 in the wrapper/service env, or dates/culture-specific formatting will crash');
  report('globalization invariant', invariantSet ? `pinned (${invariantSet})` : 'not pinned (relies on host ICU)',
    invariantSet ? null : icuInstalled ? 'fine on this host; verify ICU is present before deploying to a slimmer container' : null);

  // --- bubblewrap ---
  const bwrapPresent = !!sh('command -v bwrap');
  report('bubblewrap (bwrap)', bwrapPresent ? 'installed — real filesystem jail active' : 'NOT installed',
    bwrapPresent ? null : 'wrapper falls back to cd-only (no jail) — fine for solo dev, unsafe for any multi-user deployment');

  // --- workspace root ---
  if (!fs.existsSync(WORKSPACE_ROOT)) {
    report('workspace root', `does not exist yet (${WORKSPACE_ROOT})`, null);
  } else {
    const entries = fs.readdirSync(WORKSPACE_ROOT);
    const now = Date.now();
    const staleDirs = entries.filter((e) => {
      const stat = fs.statSync(path.join(WORKSPACE_ROOT, e));
      return (now - stat.mtimeMs) / 86400000 > STALE_DAYS_THRESHOLD;
    });
    const df = sh(`df -h ${WORKSPACE_ROOT} | tail -1`);
    const freeCol = df ? df.split(/\s+/)[3] : '?';
    const sweepScriptExists = fs.existsSync(path.join(REPO_ROOT, 'config/officecli/retention-sweep.sh'));
    const sweepTimerLive = !!sh('systemctl is-enabled officecli-retention.timer 2>/dev/null') || !!sh("crontab -l 2>/dev/null | grep -i retention-sweep");
    report('workspace root', `${entries.length} dirs, ${freeCol} free on volume`,
      staleDirs.length > 0 && !sweepTimerLive
        ? `${staleDirs.length} dir(s) older than ${STALE_DAYS_THRESHOLD}d and no sweep is actually running` +
          (sweepScriptExists ? ' (retention-sweep.sh exists in config/officecli/ but is not installed as a cron/systemd job — see its header)' : ' (retention-sweep.sh not found — see config/officecli/)')
        : !sweepTimerLive && entries.length > 0
          ? 'retention-sweep.sh exists but is not installed as a live cron/systemd job yet — nothing is stale now, but nothing will stop it accumulating again'
          : null);
  }

  // --- Ollama / model ---
  const modelTag = 'qwen3-14b-8k:latest';
  let ollamaOk = false;
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    const data = await res.json();
    ollamaOk = data.models?.some((m) => m.name === modelTag);
    report('Ollama model', ollamaOk ? `${modelTag} present` : `${modelTag} NOT FOUND`, ollamaOk ? null : 'pull it or fix the model tag in the agent config');
  } catch (err) {
    report('Ollama', 'unreachable at localhost:11434', 'is `ollama serve` running?');
  }
  const gpuLine = sh("nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader");
  report('GPU VRAM', gpuLine || 'nvidia-smi unavailable', null);

  // --- skills ---
  const skillDir = path.join(REPO_ROOT, 'skill');
  const skillContents = fs.existsSync(skillDir) ? fs.readdirSync(skillDir) : [];
  const realSkills = skillContents.filter((f) => f !== 'README.md');
  report('deployment skills (./skill/)', realSkills.length ? realSkills.join(', ') : 'empty (placeholder README only)',
    realSkills.length ? null : 'no skill content wired — by design, see OFFICECLI_HARNESS.md');

  // --- ask_user_question ---
  // NOTE: this is gated on `hitlCapable` (hardcoded true in client.js) + the
  // agent's own tools list + the admin includedTools/filteredTools list —
  // NOT on `endpoints.agents.toolApproval`, which is an unrelated feature
  // (per-tool-call human approval) that would also gate every officecli
  // tool behind approval if enabled. Don't check toolApproval here.
  const mongoScriptPath = path.join(os.tmpdir(), 'office-doctor-agent-query.js');
  fs.writeFileSync(
    mongoScriptPath,
    "print(JSON.stringify(db.agents.find({tools:{$regex:'mcp_officecli'}},{name:1,tools:1}).toArray()))",
  );
  const officecliAgentsJson = sh(`mongosh "mongodb://127.0.0.1:27017/LibreChat" --quiet --file ${mongoScriptPath}`);
  fs.rmSync(mongoScriptPath, { force: true });
  if (officecliAgentsJson) {
    try {
      const officecliAgents = JSON.parse(officecliAgentsJson);
      const missing = officecliAgents.filter((a) => !a.tools?.includes('ask_user_question'));
      report('ask_user_question wiring', `${officecliAgents.length - missing.length}/${officecliAgents.length} officecli agent(s) have it`,
        missing.length ? `missing on: ${missing.map((a) => a.name).join(', ')} — add "ask_user_question" to tools` : null);
    } catch (err) {
      report('ask_user_question wiring', 'could not parse agent query result', err.message);
    }
  } else {
    report('ask_user_question wiring', 'could not query agents (mongosh unavailable?)', 'skipped');
  }

  // --- MCP round-trip: schema count + guard verification ---
  const wsId = `office-doctor-${Date.now()}`;
  const wsDir = path.join(WORKSPACE_ROOT, wsId);
  try {
    const transport = new StdioClientTransport({ command: WRAPPER, args: [wsId], stderr: 'ignore' });
    const client = new Client({ name: 'office-doctor', version: '0.0.1' }, { capabilities: {} });
    const t0 = Date.now();
    await client.connect(transport);
    const { tools } = await client.listTools();
    report('MCP surface', `${tools.length} tools registered (${Date.now() - t0}ms to connect)`,
      tools.length === 11 ? null : `expected 11 — tool count changed, check AddElementTool/EditTextTool/etc. registration`);

    await client.callTool({ name: 'create_document', arguments: { file_path: 'doctor.docx' } });
    const badCall = await client.callTool({ name: 'add_element', arguments: { file_path: 'doctor.docx', parent_path: '/body', type: 'paragraph', properties: { text: '1. should be rejected' } } });
    report('guard: markdown-leak', badCall.isError ? 'firing correctly (rejected)' : 'NOT FIRING', badCall.isError ? null : 'ValidateNoMarkdownListMarker is not rejecting — check ParseHelpers.cs / AddElementTool.cs wiring');

    await client.callTool({ name: 'add_element', arguments: { file_path: 'doctor.docx', parent_path: '/body', type: 'table', properties: { data: 'A,B;1,2;3,4' } } });
    await client.close();
    const checks = require('./checks');
    const buf = fs.readFileSync(path.join(wsDir, 'doctor.docx'));
    const { tables } = await checks.loadDocxParagraphs(buf);
    const tableShape = checks.checkTableShape(tables);
    report('default: table header bold', tableShape.headerBold ? 'firing correctly (bold)' : 'NOT FIRING', tableShape.headerBold ? null : 'AddTable header-bold default is not applying — check WordHandler.Add.Table.cs');
  } catch (err) {
    report('MCP round-trip', `FAILED: ${err.message}`, 'see error above — this is the same path every real tool call uses');
  } finally {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }

  console.log(lines.join('\n'));
  console.log();
  if (warnings.length) {
    console.log(`${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log(`  - ${w}`));
    process.exitCode = 1;
  } else {
    console.log('All checks clean.');
  }
}

main().catch((err) => {
  console.error('[office-doctor] FATAL:', err);
  process.exit(2);
});
