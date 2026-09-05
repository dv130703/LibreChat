// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Core;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class CreateDocumentTool(ILogger<CreateDocumentTool> logger)
{
    [McpServerTool(Name = "create_document", Destructive = true, Idempotent = false, OpenWorld = false), Description(
        "Creates a new, blank Word (.docx), Excel (.xlsx), or PowerPoint (.pptx) document. " +
        "The format is inferred from the file extension. " +
        "Use this ONLY to start a brand-new document. To modify an existing one, use " +
        "add_element, edit_text, or set_properties instead — do not call this tool again on " +
        "a file you already created earlier in the same task. " +
        "Fails if the file already exists unless overwrite is set to true.")]
    public string CreateDocument(
        [Description("Relative path for the new file, including its extension, e.g. \"report.docx\".")] string file_path,
        [Description("If true, overwrite an existing file at file_path. Defaults to false to prevent accidental data loss.")] bool overwrite = false)
    {
        return ToolErrors.Run(logger, "create_document", () =>
        {
            var path = PathGuard.ResolveWithinWorkspace(file_path);

            if (File.Exists(path) && !overwrite)
            {
                throw new CliException(
                    $"A file already exists at \"{file_path}\". Creating it again would erase its current content.")
                {
                    Code = "file_exists",
                    Suggestion = "Pass overwrite: true if you intend to replace it, or choose a different file_path.",
                };
            }

            BlankDocCreator.Create(path);

            // PowerPoint decks start with zero slides — this is the earliest
            // point a model sees any guidance after create_document, and a
            // stress-test trace showed models otherwise assuming /slide[1]
            // already exists and failing repeatedly against it.
            var extraHint = Path.GetExtension(path).ToLowerInvariant() == ".pptx"
                ? " It has NO slides yet — call add_element(parent_path=\"/\", type=\"slide\") before adding anything else."
                : "";
            return $"Created \"{file_path}\". It is empty — use add_element to start adding content.{extraHint}";
        });
    }
}
