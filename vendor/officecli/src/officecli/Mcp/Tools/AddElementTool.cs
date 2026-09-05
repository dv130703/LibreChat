// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Core;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class AddElementTool(ILogger<AddElementTool> logger)
{
    [McpServerTool(Name = "add_element", Destructive = false, Idempotent = false, OpenWorld = false), Description(
        "Adds a NEW element as a child of an existing element. Use this to add content that doesn't " +
        "exist yet. " +
        "IMPORTANT — there is no \"heading\" type: a Word heading is a paragraph with " +
        "properties: {\"style\": \"Heading1\"} (or Heading2, Heading3, ...) — use " +
        "type=\"paragraph\" with that style property, never type=\"heading\" (it will fail). " +
        "IMPORTANT — Excel cells already exist on every sheet from creation (a blank sheet's A1 is an " +
        "empty, addressable cell, not a missing one). Do NOT add_element type=\"row\"/\"cell\" to " +
        "populate them — call set_properties directly on the cell path instead, e.g. " +
        "set_properties(path=\"/Sheet1/A1\", properties={\"value\": \"Quarter\"}). Only use add_element " +
        "for genuinely new rows/columns/charts/tables beyond the sheet's existing grid — and if you do, " +
        "an Excel cell's address property is named \"ref\" (e.g. {\"ref\": \"D5\"}), never \"path\". " +
        "IMPORTANT — a new PowerPoint file has ZERO slides. Before adding anything to a slide, first " +
        "add_element(parent_path=\"/\", type=\"slide\") — do not assume /slide[1] already exists. Once a " +
        "slide exists, add a shape carrying its own text directly: " +
        "add_element(parent_path=\"/slide[1]\", type=\"shape\", properties={\"text\": \"...\"}) — a shape's " +
        "text goes in its own text property; you do not need a separate paragraph type for slide text. " +
        "IMPORTANT — for a Word bulleted or numbered list, do NOT type a literal \"- \"/\"1. \" prefix into " +
        "the paragraph's text — that is plain text, not a real list, and won't render, renumber, or outline " +
        "like one. Instead add each list item as type=\"paragraph\" with properties " +
        "{\"text\": \"...\", \"listStyle\": \"bullet\"} (or \"ordered\" for numbers) — consecutive paragraphs " +
        "with the same listStyle automatically continue the same list. " +
        "properties is always a FLAT string map — never nest an array or object as a property value " +
        "(e.g. do not send {\"cells\": [...]}) — that fails without a specific error message from this tool. " +
        "For the authoritative list of valid type values and their properties for a format, call " +
        "get_schema_help(format) — do not guess a type name; an unsupported guess costs a failed call. " +
        "Do NOT use this to change an existing element's text — use edit_text (for a text find/replace) " +
        "or set_properties (for styling) instead; calling add_element on a path that already holds " +
        "the content you want will create a duplicate. " +
        "By default the new element is appended as the last child; pass after or before to position it " +
        "next to a specific sibling instead.")]
    public string AddElement(
        [Description("Relative path to the document.")] string file_path,
        [Description("1-based path of the PARENT to add under, e.g. \"/body\" (Word), \"/Sheet1\" (Excel), \"/slide[1]\" (PowerPoint).")] string parent_path,
        [Description("Element type to add — see the tool description for the exact valid list per format. For a Word heading, this is \"paragraph\" (with a style property), not \"heading\".")] string type,
        [Description("Property values for the new element as a flat string map, e.g. {\"text\": \"Hello\", \"bold\": \"true\"}. All values are strings, including numbers/booleans/colors (\"24\", \"true\", \"FF0000\").")] Dictionary<string, string>? properties = null,
        [Description("Path of an existing sibling to insert the new element immediately after. Mutually exclusive with before.")] string? after = null,
        [Description("Path of an existing sibling to insert the new element immediately before. Mutually exclusive with after.")] string? before = null)
    {
        return ToolErrors.Run(logger, "add_element", () =>
        {
            // Observed failure mode (stress-test trace, 2026-09-05): a model
            // asked for a "heading" and, on the resulting generic "unknown
            // type" error, silently gave up on the heading rather than
            // retrying — then told the user it had been added anyway. A
            // short-circuit with the exact fix inline is cheaper for a model
            // to act on than expecting it to parse the full valid-types list.
            if (string.Equals(type, "heading", StringComparison.OrdinalIgnoreCase))
            {
                throw new CliException(
                    "There is no \"heading\" element type. Add a paragraph instead, with a heading style: " +
                    "call add_element again with type=\"paragraph\" and properties including " +
                    "{\"style\": \"Heading1\"} (or Heading2/Heading3).")
                {
                    Code = "invalid_value",
                    Suggestion = "Retry with type=\"paragraph\", properties={\"text\": \"...\", \"style\": \"Heading1\"}.",
                };
            }

            var filePath = PathGuard.ResolveWithinWorkspace(file_path);
            InsertPosition? position = (after, before) switch
            {
                (not null, not null) => throw new CliException("Pass only one of after or before, not both.") { Code = "invalid_value" },
                (not null, null) => InsertPosition.AfterElement(after),
                (null, not null) => InsertPosition.BeforeElement(before),
                _ => null,
            };

            using var handler = DocumentHandlerFactory.Open(filePath, editable: true);
            var newPath = handler.Add(parent_path, type, position, properties ?? new Dictionary<string, string>());
            handler.Save();
            return $"Added {type} at {newPath}.";
        });
    }
}
