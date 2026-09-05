#!/usr/bin/env node
/**
 * Smoke test: validates the direct Ollama+MCP pipeline before committing to
 * the full 20-trial run. Connects to the officecli MCP server via the same
 * wrapper script librechat.yaml uses, lists tools, and drives one trivial
 * tool-calling turn through Ollama directly (no LibreChat backend involved).
 */
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const WRAPPER = '/home/daniel/LibreChat/config/officecli/mcp-wrapper.sh';
const WORKSPACE_ID = 'harness-smoke-' + Date.now();
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL = 'qwen3-14b-8k:latest';

function ollamaToolFromMcp(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

async function main() {
  console.log('[smoke] workspace id:', WORKSPACE_ID);

  const transport = new StdioClientTransport({
    command: WRAPPER,
    args: [WORKSPACE_ID],
  });
  const client = new Client({ name: 'officecli-harness-smoke', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  console.log('[smoke] MCP connected');

  const { tools } = await client.listTools();
  console.log(`[smoke] ${tools.length} tools registered:`, tools.map((t) => t.name).join(', '));

  const ollamaTools = tools.map(ollamaToolFromMcp);

  const messages = [
    {
      role: 'system',
      content:
        'Your OfficeCLI working directory is scoped to this conversation\'s user — use relative paths only (e.g. "report.xlsx"), never absolute paths.',
    },
    { role: 'user', content: 'Create a Word document called test.docx with a single paragraph that says "Hello world".' },
  ];

  let turns = 0;
  let lastPromptTokens = null;
  while (turns < 6) {
    turns += 1;
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: ollamaTools,
        stream: false,
        options: { num_ctx: 8192, temperature: 0.3, seed: 12345 },
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[smoke] Ollama error:', data.error);
      process.exit(1);
    }
    lastPromptTokens = data.prompt_eval_count;
    console.log(`[smoke] turn ${turns}: prompt_eval_count=${data.prompt_eval_count} eval_count=${data.eval_count}`);
    const msg = data.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log('[smoke] final response:', msg.content);
      break;
    }

    for (const call of msg.tool_calls) {
      console.log('[smoke] tool call:', call.function.name, JSON.stringify(call.function.arguments));
      let toolResultText;
      try {
        const result = await client.callTool({
          name: call.function.name,
          arguments: call.function.arguments,
        });
        toolResultText = (result.content || [])
          .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
          .join('\n');
      } catch (err) {
        toolResultText = `ERROR: ${err.message}`;
      }
      console.log('[smoke] tool result:', toolResultText.slice(0, 500));
      messages.push({ role: 'tool', content: toolResultText });
    }
  }

  console.log('[smoke] prompt_overhead check (first call prompt_eval_count):', messages.length ? 'see turn 1 above' : 'n/a');

  const fs = require('fs');
  const workspaceDir = `/home/daniel/.local/share/officecli/users/${WORKSPACE_ID}`;
  console.log('[smoke] workspace contents:', fs.existsSync(workspaceDir) ? fs.readdirSync(workspaceDir) : '(missing)');

  await client.close();
  console.log('[smoke] done');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
