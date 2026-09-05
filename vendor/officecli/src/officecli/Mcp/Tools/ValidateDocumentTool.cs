// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using System.Text;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class ValidateDocumentTool(ILogger<ValidateDocumentTool> logger)
{
    [McpServerTool(Name = "validate_document", ReadOnly = true, OpenWorld = false), Description(
        "Validates a document against the OpenXML schema and reports any structural errors. " +
        "Run this after making edits, before telling the user a document is finished — a document " +
        "that passes validate_document can still have content problems, so also check view_issues.")]
    public string ValidateDocument(
        [Description("Relative path to the document to validate.")] string file_path)
    {
        return ToolErrors.Run(logger, "validate_document", () =>
        {
            var path = PathGuard.ResolveWithinWorkspace(file_path);
            using var handler = DocumentHandlerFactory.Open(path, editable: false);
            var errors = handler.Validate();

            if (errors.Count == 0)
                return "Validation passed: no schema errors found.";

            var sb = new StringBuilder();
            sb.Append($"Validation FAILED: {errors.Count} schema error(s) found.\n");
            foreach (var e in errors.Take(20))
            {
                sb.Append($"- [{e.ErrorType}] {e.Description}");
                if (e.Path != null) sb.Append($" (at {e.Path})");
                sb.Append('\n');
            }
            if (errors.Count > 20)
                sb.Append($"...and {errors.Count - 20} more.\n");
            return sb.ToString();
        });
    }
}
