// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class RemoveElementTool(ILogger<RemoveElementTool> logger)
{
    [McpServerTool(Name = "remove_element", Destructive = true, Idempotent = true, OpenWorld = false), Description(
        "Permanently removes an element (paragraph, row, slide, shape, etc.) from a document. " +
        "This cannot be undone. Use get_element or query_elements first to confirm you have the " +
        "right path before removing it.")]
    public string RemoveElement(
        [Description("Relative path to the document.")] string file_path,
        [Description("1-based path to the element to remove, e.g. \"/body/p[3]\", \"/slide[2]/shape[1]\".")] string path)
    {
        return ToolErrors.Run(logger, "remove_element", () =>
        {
            var filePath = PathGuard.ResolveWithinWorkspace(file_path);
            using var handler = DocumentHandlerFactory.Open(filePath, editable: true);
            var warning = handler.Remove(path);
            handler.Save();
            return warning is null
                ? $"Removed \"{path}\"."
                : $"Removed \"{path}\". Warning: {warning}";
        });
    }
}
