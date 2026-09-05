#!/usr/bin/env node
/**
 * Runs the 20-trial control arm (skills_enabled: false) of
 * OFFICECLI_HARNESS.md directly against Ollama + the officecli MCP server,
 * bypassing the LibreChat web/auth layer entirely (per the user's chosen
 * "run it myself, proxy axis 2" option). See OFFICECLI_HARNESS.md for the
 * full protocol this implements.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { scenarios, setupFixture, FIXTURE_TIMELINE_TEXT } = require('./scenarios');
const checks = require('./checks');

const WRAPPER = '/home/daniel/LibreChat/config/officecli/mcp-wrapper.sh';
const WORKSPACE_ID = 'harness-control';
const WORKSPACE_DIR = `/home/daniel/.local/share/officecli/users/${WORKSPACE_ID}`;
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL = 'qwen3-14b-8k:latest';
const NUM_CTX = 8192;
const TEMPERATURE = 0.3;
const CONTEXT_LIMIT_MARGIN = 200;
const MAX_TURNS = 8;
const TRIAL_TIMEOUT_MS = 180000;
const RUNS_PER_SCENARIO = 4;
const OFFICE_EXTS = ['.docx', '.xlsx', '.pptx'];

const SERVER_INSTRUCTIONS =
  "Your OfficeCLI working directory is scoped to this conversation's user — use relative paths only (e.g. \"report.xlsx\"), never absolute paths.";

const resultsDir = path.join(__dirname, 'results', 'control');
fs.mkdirSync(resultsDir, { recursive: true });

function ollamaToolFromMcp(tool) {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description || '', parameters: tool.inputSchema || { type: 'object', properties: {} } },
  };
}

function resetWorkspace() {
  if (fs.existsSync(WORKSPACE_DIR)) {
    for (const entry of fs.readdirSync(WORKSPACE_DIR)) {
      fs.rmSync(path.join(WORKSPACE_DIR, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
  return true;
}

function listOfficeFiles() {
  if (!fs.existsSync(WORKSPACE_DIR)) return [];
  return fs.readdirSync(WORKSPACE_DIR).filter((f) => OFFICE_EXTS.includes(path.extname(f).toLowerCase()));
}

async function connectMcp() {
  const transport = new StdioClientTransport({ command: WRAPPER, args: [WORKSPACE_ID], stderr: 'ignore' });
  const client = new Client({ name: 'officecli-harness', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools };
}

async function measurePromptOverhead(tools) {
  const ollamaTools = tools.map(ollamaToolFromMcp);
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SERVER_INSTRUCTIONS }],
      tools: ollamaTools,
      stream: false,
      options: { num_ctx: NUM_CTX, temperature: TEMPERATURE, num_predict: 1 },
    }),
  });
  const data = await res.json();
  return data.prompt_eval_count ?? null;
}

/**
 * Timed via an AbortController, not Promise.race — race() doesn't cancel the
 * loser, so a slow trial kept running in the background after "losing",
 * silently discarding its own tool-call log (reported as 0 calls) and
 * leaving its officecli subprocess orphaned to contend with the next
 * trial. This version aborts the in-flight fetch and stops the loop
 * immediately, so whatever ran before the abort is still recorded.
 */
async function runTrial(scenario, runIndex, client, ollamaTools) {
  const seed = scenario._index * 100 + runIndex;
  const messages = [
    { role: 'system', content: SERVER_INSTRUCTIONS },
    { role: 'user', content: scenario.prompt },
  ];

  const toolCallLog = [];
  const promptTokensPerCall = [];
  let hitContextLimit = false;
  let finalContent = '';
  let turns = 0;
  let timedOut = false;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRIAL_TIMEOUT_MS);

  try {
    while (turns < MAX_TURNS && !controller.signal.aborted) {
      turns += 1;
      let data;
      try {
        const res = await fetch(OLLAMA_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages,
            tools: ollamaTools,
            stream: false,
            options: { num_ctx: NUM_CTX, temperature: TEMPERATURE, seed },
          }),
          signal: controller.signal,
        });
        data = await res.json();
      } catch (err) {
        if (controller.signal.aborted) break;
        finalContent = `FETCH_ERROR: ${err.message}`;
        break;
      }
      if (data.error) {
        finalContent = `OLLAMA_ERROR: ${data.error}`;
        break;
      }
      if (typeof data.prompt_eval_count === 'number') {
        promptTokensPerCall.push(data.prompt_eval_count);
        if (data.prompt_eval_count >= NUM_CTX - CONTEXT_LIMIT_MARGIN) hitContextLimit = true;
      }
      const msg = data.message;
      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        finalContent = msg.content || '';
        break;
      }

      for (const call of msg.tool_calls) {
        if (controller.signal.aborted) break;
        let isError = false;
        let resultText = '';
        try {
          const result = await client.callTool({ name: call.function.name, arguments: call.function.arguments });
          isError = !!result.isError;
          resultText = (result.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        } catch (err) {
          isError = true;
          resultText = `ERROR: ${err.message}`;
        }
        toolCallLog.push({ name: call.function.name, arguments: call.function.arguments, isError, resultText: resultText.slice(0, 300) });
        messages.push({ role: 'tool', content: resultText });
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (timedOut) finalContent = finalContent || 'TIMED_OUT';
  return { seed, turns, toolCallLog, promptTokensPerCall, hitContextLimit, finalContent, timedOut };
}

function scoreCallValidity(toolCallLog) {
  const total = toolCallLog.length;
  const valid = toolCallLog.filter((c) => !c.isError).length;
  return { total, valid, rate: total === 0 ? null : valid / total };
}

async function scoreArtifact(scenario, deliveredFile) {
  if (!deliveredFile) return { applicable: false };
  const buffer = fs.readFileSync(path.join(WORKSPACE_DIR, deliveredFile));
  const ext = path.extname(deliveredFile).toLowerCase();
  if (ext !== '.docx') return { applicable: false, note: `no parser wired for ${ext} yet` };

  const { paragraphs, tables } = await checks.loadDocxParagraphs(buffer);
  const results = {};
  for (const checkName of scenario.checks) {
    switch (checkName) {
      case 'markdownLeak':
        results.markdownLeak = checks.checkMarkdownLeak(paragraphs);
        break;
      case 'placeholderResidue':
        results.placeholderResidue = checks.checkPlaceholderResidue(paragraphs);
        break;
      case 'headingStyle':
        results.headingStyle = checks.checkHeadingStyle(paragraphs);
        break;
      case 'headingHierarchy':
        results.headingHierarchy = checks.checkHeadingHierarchy(paragraphs);
        break;
      case 'tableShape':
        results.tableShape = checks.checkTableShape(tables);
        break;
      case 'timelineUnchanged':
        results.timelineUnchanged = checks.checkTimelineUnchanged(paragraphs, FIXTURE_TIMELINE_TEXT);
        break;
      default:
        break;
    }
  }
  const allPass = Object.values(results).every((r) => r.pass !== false);
  return { applicable: true, allPass, results };
}

async function main() {
  const gitHead = execSync('git rev-parse HEAD', { cwd: '/home/daniel/LibreChat' }).toString().trim();
  const gitDirty = execSync('git status --porcelain', { cwd: '/home/daniel/LibreChat' }).toString().trim().length > 0;

  scenarios.forEach((s, i) => { s._index = i; });

  console.log('[run] connecting to officecli MCP server for tool-schema listing + prompt_overhead measurement...');
  const probe = await connectMcp();
  const ollamaTools = probe.tools.map(ollamaToolFromMcp);
  const promptOverheadTokens = await measurePromptOverhead(probe.tools);
  await probe.client.close();
  console.log(`[run] prompt_overhead_tokens (system + ${probe.tools.length} tool schemas, empty conversation): ${promptOverheadTokens}`);

  const header = {
    date: new Date().toISOString(),
    git_head: gitHead,
    git_dirty: gitDirty,
    model_tag: MODEL,
    quant: 'Q4_K_M',
    num_ctx: NUM_CTX,
    kv_cache_type: 'q8_0',
    temperature: TEMPERATURE,
    skills_enabled_on_agent: false,
    skill_dir_contents: fs.readdirSync(path.join('/home/daniel/LibreChat', 'skill')),
    prompt_overhead_tokens: promptOverheadTokens,
    arm: 'control',
    axis2_note: 'PROXY — file written to workspace, not verified promoted through processOfficeCliOutput/claimCodeFile (see OFFICECLI_HARNESS.md)',
  };
  fs.writeFileSync(path.join(resultsDir, '_header.json'), JSON.stringify(header, null, 2));
  console.log('[run] header:', header);

  const allTrials = [];

  for (const scenario of scenarios) {
    for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex += 1) {
      const trialId = `${scenario.id}-r${runIndex}`;
      console.log(`\n[run] === trial ${trialId} ===`);

      const resetOk = resetWorkspace();
      const { client } = await connectMcp();

      if (scenario.needsFixture) {
        await setupFixture(client);
      }

      let trialResult;
      try {
        trialResult = await runTrial(scenario, runIndex, client, ollamaTools);
      } catch (err) {
        trialResult = { error: err.message, toolCallLog: [], promptTokensPerCall: [], hitContextLimit: false, finalContent: '' };
      }

      const officeFiles = listOfficeFiles();
      const deliveredFile = scenario.expectFilename && officeFiles.includes(scenario.expectFilename)
        ? scenario.expectFilename
        : officeFiles[0] || null;

      const callValidity = scoreCallValidity(trialResult.toolCallLog || []);

      let taskCompletion;
      if (scenario.id === 'underspecified') {
        if (deliveredFile) taskCompletion = 'delivered';
        else if (/\?/.test(trialResult.finalContent || '')) taskCompletion = 'clarification_requested';
        else taskCompletion = 'failed';
      } else {
        taskCompletion = deliveredFile ? 'delivered' : 'failed';
      }

      let artifactCorrectness = { applicable: false };
      try {
        artifactCorrectness = await scoreArtifact(scenario, deliveredFile);
      } catch (err) {
        artifactCorrectness = { applicable: true, error: err.message };
      }

      const record = {
        trialId,
        scenarioId: scenario.id,
        runIndex,
        seed: scenario._index * 100 + runIndex,
        workspaceResetConfirmed: resetOk,
        officeFilesInWorkspace: officeFiles,
        deliveredFile,
        taskCompletion,
        callValidity,
        artifactCorrectness,
        hitContextLimit: trialResult.hitContextLimit,
        promptTokensPerCall: trialResult.promptTokensPerCall,
        turns: trialResult.turns,
        toolCallLog: trialResult.toolCallLog,
        finalContent: trialResult.finalContent,
        timedOut: !!trialResult.timedOut,
        error: trialResult.error || null,
      };

      fs.writeFileSync(path.join(resultsDir, `${trialId}.json`), JSON.stringify(record, null, 2));
      allTrials.push(record);

      console.log(`[run] ${trialId}: completion=${taskCompletion} callValidity=${JSON.stringify(callValidity)} hitContextLimit=${trialResult.hitContextLimit} timedOut=${!!trialResult.timedOut} artifactPass=${artifactCorrectness.allPass}`);

      try {
        await client.close();
      } catch (err) {
        console.log(`[run] ${trialId}: client.close() warning: ${err.message}`);
      }
    }
  }

  fs.writeFileSync(path.join(resultsDir, '_all_trials.json'), JSON.stringify(allTrials, null, 2));
  console.log(`\n[run] done — ${allTrials.length} trials written to ${resultsDir}`);
}

main().catch((err) => {
  console.error('[run] FATAL:', err);
  process.exit(1);
});
