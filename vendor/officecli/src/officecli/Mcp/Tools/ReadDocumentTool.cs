// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Core;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class ReadDocumentTool(ILogger<ReadDocumentTool> logger)
{
    [McpServerTool(Name = "read_document", ReadOnly = true, OpenWorld = false), Description(
        "Reads the content of an existing Word, Excel, or PowerPoint document as plain text. " +
        "Use this FIRST, before editing, so you know the exact current text — edit_text requires " +
        "an exact match of existing text, and this tool is how you obtain it. " +
        "For a structural overview instead of full text (heading list, sheet names, slide count), " +
        "pass mode=\"outline\". Output is capped at max_lines to avoid overwhelming your context; " +
        "use start_line to page through a longer document.")]
    public string ReadDocument(
        [Description("Relative path to the document to read.")] string file_path,
        [Description("\"text\" for full readable content (default), or \"outline\" for a structural summary (headings/sheets/slides).")] string mode = "text",
        [Description("1-based line to start reading from. Defaults to the beginning.")] int? start_line = null,
        [Description("Maximum number of lines to return in one call. Defaults to 200 to keep the response small; page with start_line for more.")] int max_lines = 200)
    {
        return ToolErrors.Run(logger, "read_document", () =>
        {
            var path = PathGuard.ResolveWithinWorkspace(file_path);
            using var handler = DocumentHandlerFactory.Open(path, editable: false);

            if (mode == "outline")
                return handler.ViewAsOutline();

            if (mode != "text")
                throw new CliException($"Unknown mode \"{mode}\".")
                {
                    Code = "invalid_value",
                    ValidValues = ["text", "outline"],
                };

            var endLine = start_line.HasValue ? start_line.Value + max_lines - 1 : (int?)null;
            return handler.ViewAsText(startLine: start_line, endLine: endLine, maxLines: max_lines);
        });
    }
}
