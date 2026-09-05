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
public sealed class GetElementTool(ILogger<GetElementTool> logger)
{
    [McpServerTool(Name = "get_element", ReadOnly = true, OpenWorld = false), Description(
        "Gets the exact current properties (text, style, formatting, formula, etc.) of ONE specific " +
        "element in a document, addressed by its path. " +
        "Paths are 1-based: \"/body/p[1]\" (first paragraph), \"/Sheet1/A1\" (a cell), " +
        "\"/slide[1]/shape[2]\" (a shape on a slide). " +
        "Use this before set_properties to see an element's current values, or to get the exact " +
        "text a paragraph currently holds before calling edit_text on it. " +
        "Use query_elements instead if you don't already know the exact path.")]
    public string GetElement(
        [Description("Relative path to the document.")] string file_path,
        [Description("1-based path to the element, e.g. \"/body/p[1]\", \"/Sheet1/B6\", \"/slide[2]/shape[1]\".")] string path,
        [Description("How many levels of children to include. 1 = the element itself plus its direct children.")] int depth = 1)
    {
        return ToolErrors.Run(logger, "get_element", () =>
        {
            var filePath = PathGuard.ResolveWithinWorkspace(file_path);
            using var handler = DocumentHandlerFactory.Open(filePath, editable: false);
            var node = handler.Get(path, depth);
            // Reuses the project's existing source-generated serialization context
            // (AppJsonContext) rather than reflection-based JsonSerializer.Serialize —
            // this project ships PublishTrimmed=true, and reflection-based
            // serialization of a type not registered for it is unsafe under trimming.
            return JsonSerializer.Serialize(node, AppJsonContext.Default.DocumentNode);
        });
    }
}
