// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using System.Linq;
using Microsoft.Extensions.Logging;
using ModelContextProtocol;
using ModelContextProtocol.Server;
using OfficeCli.Help;

namespace OfficeCli.Mcp.Tools;

/// <summary>
/// Wraps the engine's existing schema-help system (originally only reachable
/// via the CLI's `help` command / the old single-tool server's `load_skill`
/// verb) as its own discovery tool. Added after a stress test found models
/// repeatedly guessing wrong element types and property names (a "heading"
/// type that doesn't exist, "path" instead of "ref" for an Excel cell
/// address, assuming PowerPoint placeholders exist by default) and then
/// either giving up silently or claiming success anyway. Checking here FIRST
/// is cheap; a failed add_element/set_properties call is not.
/// </summary>
[McpServerToolType]
public sealed class GetSchemaHelpTool(ILogger<GetSchemaHelpTool> logger)
{
    /// <summary>
    /// Cap on the per-element detail response. A stress-test trace found a
    /// model reading the FULL, unabridged schema dump for a property-dense
    /// element (Excel's "cell", ~50 properties with examples) and derailing
    /// into narrating the documentation back to the user instead of using it
    /// and continuing the task. Truncating trades completeness for keeping
    /// the model on-task; the verb filter is the intended way to get a
    /// narrower, complete answer instead of a truncated broad one.
    /// </summary>
    private const int MaxDetailChars = 1800;

    [McpServerTool(Name = "get_schema_help", ReadOnly = true, OpenWorld = false), Description(
        "Looks up the EXACT valid element types and property names for a document format. Call this " +
        "BEFORE guessing a type or property name in add_element/set_properties — a wrong guess costs a " +
        "failed tool call, this costs nothing. " +
        "Omit element_type to list every valid element type for the format (this is the authoritative " +
        "list — do not use a type not in it, e.g. there is no \"heading\" type). " +
        "Provide element_type to see that specific element's valid properties and what they mean — for a " +
        "property-heavy element this can be long, so pass verb to narrow it (e.g. verb=\"add\") rather " +
        "than reading the full unfiltered dump. " +
        "This tool returns REFERENCE material for YOU to act on — extract only the property/type name " +
        "you need and continue the task; do not summarize or repeat this documentation to the user.")]
    public string GetSchemaHelp(
        [Description("Document format: \"docx\" (Word), \"xlsx\" (Excel), or \"pptx\" (PowerPoint).")] string format,
        [Description("Optional: an element type (e.g. \"paragraph\", \"cell\", \"shape\", \"slide\") to see its exact valid properties. Omit to list all element types for the format.")] string? element_type = null,
        [Description("Optional: only show elements/properties that support this verb (\"add\", \"set\", \"get\", \"query\", \"remove\"). Strongly recommended when looking up a property-heavy element — narrows the response instead of truncating it.")] string? verb = null)
    {
        return ToolErrors.Run(logger, "get_schema_help", () =>
        {
            string canonicalFormat;
            try
            {
                canonicalFormat = SchemaHelpLoader.NormalizeFormat(format);
            }
            catch (InvalidOperationException ex)
            {
                // Already a clean, specific message (includes a "did you
                // mean" suggestion) — surface it as-is instead of letting the
                // generic ToolErrors fallback prefix it redundantly.
                throw new McpException(ex.Message);
            }

            if (element_type == null)
            {
                var all = SchemaHelpLoader.ListElements(canonicalFormat);
                var filtered = verb == null
                    ? all
                    : all.Where(el => SchemaHelpLoader.ElementSupportsVerb(canonicalFormat, el, verb)).ToList();
                var verbNote = verb == null ? "" : $" supporting \"{verb}\"";
                return $"Valid element types for {canonicalFormat}{verbNote}: {string.Join(", ", filtered)}. " +
                       "Call get_schema_help again with element_type set to one of these for its exact properties.";
            }

            try
            {
                using var doc = SchemaHelpLoader.LoadSchema(canonicalFormat, element_type);
                var rendered = SchemaHelpRenderer.RenderHuman(doc, verb);
                if (rendered.Length <= MaxDetailChars)
                    return rendered;

                return rendered[..MaxDetailChars] +
                       $"\n\n[truncated — {rendered.Length - MaxDetailChars} more characters omitted. " +
                       (verb == null
                           ? "Re-call with verb set to \"add\" or \"set\" to see a shorter, complete answer instead of this truncated one."
                           : "This element has many properties even filtered by verb — search the text above for the specific property name you need.") +
                       "]";
            }
            catch (InvalidOperationException ex)
            {
                throw new McpException(ex.Message);
            }
        });
    }
}
