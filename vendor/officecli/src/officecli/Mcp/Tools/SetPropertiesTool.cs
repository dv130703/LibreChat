// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class SetPropertiesTool(ILogger<SetPropertiesTool> logger)
{
    [McpServerTool(Name = "set_properties", Destructive = true, Idempotent = true, OpenWorld = false), Description(
        "Sets formatting or data properties on an EXISTING element: bold, color, font size, cell " +
        "formula/value, alignment, and similar. Use get_element first if you're unsure of an " +
        "element's current property names, or get_schema_help for the authoritative list of valid " +
        "property names for an element type. " +
        "Excel cells always already exist (a blank sheet's A1 is empty, not missing) — set_properties " +
        "on a cell path works even if nothing was ever written there; there is no need to add_element " +
        "a cell first. " +
        "Do NOT use this to change body text — use edit_text for that (it requires an exact old_str " +
        "match, which prevents accidentally overwriting text you didn't mean to touch). " +
        "Unsupported property names for the element's type are ignored and listed in the response, " +
        "not silently dropped.")]
    public string SetProperties(
        [Description("Relative path to the document.")] string file_path,
        [Description("1-based path to the element to modify, e.g. \"/body/p[1]\", \"/Sheet1/B6\".")] string path,
        [Description("Properties to set as a flat string map, e.g. {\"bold\": \"true\", \"color\": \"FF0000\", \"size\": \"24pt\"} or {\"formula\": \"SUM(B2:B5)\"} for a cell. All values are strings.")] Dictionary<string, string> properties)
    {
        return ToolErrors.Run(logger, "set_properties", () =>
        {
            var filePath = PathGuard.ResolveWithinWorkspace(file_path);
            using var handler = DocumentHandlerFactory.Open(filePath, editable: true);
            var unsupported = handler.Set(path, properties);
            handler.Save();

            if (unsupported.Count == 0)
                return $"Updated \"{path}\": {FormatProps(properties)}.";

            var applied = properties.Keys.Except(unsupported);
            return $"Updated \"{path}\": {FormatProps(properties.Where(kv => applied.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value))}. " +
                   $"NOT applied (unsupported on this element type): {string.Join(", ", unsupported)}. " +
                   "Call get_schema_help with this element's type for the exact valid property names instead of guessing again.";
        });
    }

    private static string FormatProps(Dictionary<string, string> props) =>
        string.Join(", ", props.Select(kv => $"{kv.Key}={kv.Value}"));
}
