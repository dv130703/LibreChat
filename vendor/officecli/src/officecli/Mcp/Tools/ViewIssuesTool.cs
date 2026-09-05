// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using System.Text;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class ViewIssuesTool(ILogger<ViewIssuesTool> logger)
{
    [McpServerTool(Name = "view_issues", ReadOnly = true, OpenWorld = false), Description(
        "Scans a document for content and layout problems that schema validation does not catch: " +
        "overflowing text, missing formatting, broken formulas, and similar. Run this (together with " +
        "validate_document) before telling the user a document is finished.")]
    public string ViewIssues(
        [Description("Relative path to the document.")] string file_path,
        [Description("Only report one category: \"Format\", \"Content\", or \"Structure\". Omit to report all.")] string? issue_type = null)
    {
        return ToolErrors.Run(logger, "view_issues", () =>
        {
            var path = PathGuard.ResolveWithinWorkspace(file_path);
            using var handler = DocumentHandlerFactory.Open(path, editable: false);
            var issues = handler.ViewAsIssues(issue_type);

            if (issues.Count == 0)
                return "No issues found.";

            var sb = new StringBuilder();
            sb.Append($"Found {issues.Count} issue(s):\n");
            foreach (var issue in issues)
            {
                sb.Append($"- [{issue.Severity}/{issue.Type}] {issue.Path}: {issue.Message}");
                if (!string.IsNullOrEmpty(issue.Suggestion))
                    sb.Append($" — Suggestion: {issue.Suggestion}");
                sb.Append('\n');
            }
            return sb.ToString();
        });
    }
}
