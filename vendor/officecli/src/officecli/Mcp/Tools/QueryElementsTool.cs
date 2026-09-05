// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Core;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class QueryElementsTool(ILogger<QueryElementsTool> logger)
{
    [McpServerTool(Name = "query_elements", ReadOnly = true, OpenWorld = false), Description(
        "Finds elements in a document matching a CSS-like selector, when you don't already know " +
        "their exact path. Examples: \"p\" (all paragraphs), \"cell[bold=true]\" (bold cells), " +
        "\"shape\" (all shapes on all slides). Returns each match's path (usable with get_element, " +
        "edit_text, or set_properties), its type, and a short text preview. " +
        "Use get_element instead if you already know the exact path of the single element you need.")]
    public string QueryElements(
        [Description("Relative path to the document.")] string file_path,
        [Description("CSS-like selector, e.g. \"p\", \"cell[bold=true]\", \"shape\".")] string selector)
    {
        return ToolErrors.Run(logger, "query_elements", () =>
        {
            var filePath = PathGuard.ResolveWithinWorkspace(file_path);
            using var handler = DocumentHandlerFactory.Open(filePath, editable: false);
            var matches = handler.Query(selector);
            if (matches.Count == 0)
                return $"No elements matched selector \"{selector}\".";
            return JsonSerializer.Serialize(matches, AppJsonContext.Default.ListDocumentNode);
        });
    }
}
