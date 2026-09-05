// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using Xunit;

// Every tool resolves file_path against Directory.GetCurrentDirectory() (see
// PathGuard), matching how the real MCP server process's cwd is the per-user
// workspace directory in production. Tests that exercise this therefore
// mutate the process-wide current directory in their setup — safe only if
// tests never run concurrently with each other.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
