// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using OfficeCli.Core;
using OfficeCli.Handlers;

namespace OfficeCli.Mcp.Tools;

[McpServerToolType]
public sealed class EditTextTool(ILogger<EditTextTool> logger)
{
    /// <summary>Characters of context shown on each side of an edit in the success message.</summary>
    private const int ContextChars = 60;

    [McpServerTool(Name = "edit_text", Destructive = true, Idempotent = false, OpenWorld = false), Description(
        "Edits an element's text by replacing an EXACT substring match. This is the preferred way to " +
        "change existing text — you do NOT need to retype the whole element, only the part that " +
        "changes. " +
        "You MUST provide old_str exactly as it currently appears (use read_document or get_element " +
        "first to see the real text — do not guess). " +
        "old_str must match exactly ONE location in the element; if it could match more than once, " +
        "include more surrounding text to make it unique, or pass replace_all: true to change every " +
        "occurrence. " +
        "If the element doesn't exist yet, use add_element instead — this tool only edits existing text.")]
    public string EditText(
        [Description("Relative path to the document.")] string file_path,
        [Description("1-based path to the element whose text should change, e.g. \"/body/p[2]\", \"/Sheet1/A1\".")] string path,
        [Description("The exact, currently-existing text to find. Must match verbatim, including punctuation and whitespace.")] string old_str,
        [Description("The text to replace it with.")] string new_str,
        [Description("If true, replace every occurrence of old_str instead of requiring exactly one match.")] bool replace_all = false)
    {
        return ToolErrors.Run(logger, "edit_text", () =>
        {
            var filePath = PathGuard.ResolveWithinWorkspace(file_path);
            if (filePath.EndsWith(".docx", StringComparison.OrdinalIgnoreCase))
            {
                ParseHelpers.ValidateNoMarkdownListMarker(new_str, "new_str");
            }
            using var handler = DocumentHandlerFactory.Open(filePath, editable: true);

            var node = handler.Get(path, depth: 1);
            var currentText = node.Text;
            if (string.IsNullOrEmpty(currentText))
            {
                throw new CliException(
                    $"\"{path}\" has no text content to edit (it may be an empty or non-text element).")
                {
                    Code = "no_text_content",
                    Suggestion = "Use get_element to inspect this element, or add_element to add new content instead of editing.",
                };
            }

            var occurrences = CountOccurrences(currentText, old_str);
            if (occurrences == 0)
            {
                throw new CliException(
                    $"old_str was not found in \"{path}\". It must match the existing text exactly, " +
                    "including whitespace and punctuation.")
                {
                    Code = "old_str_not_found",
                    Suggestion = $"Here is the ACTUAL current text of \"{path}\" — copy old_str from this exactly: \"{Truncate(currentText, 500)}\"",
                };
            }
            if (occurrences > 1 && !replace_all)
            {
                throw new CliException(
                    $"old_str matches {occurrences} locations in \"{path}\", but edit_text requires a single, " +
                    "unambiguous match.")
                {
                    Code = "old_str_not_unique",
                    Suggestion = "Include more surrounding text in old_str to make it unique, or pass replace_all: true to change every occurrence.",
                };
            }

            var newText = replace_all
                ? currentText.Replace(old_str, new_str)
                : ReplaceFirst(currentText, old_str, new_str);

            handler.Set(path, new Dictionary<string, string> { ["text"] = newText });
            handler.Save();

            // Micro-output: a snippet around the edit, not the whole (possibly large)
            // element or document — keeps a smaller model's context from being
            // flooded by content it already knows it just wrote.
            var snippet = SnippetAround(newText, new_str, ContextChars);
            var occurrenceNote = replace_all && occurrences > 1 ? $" ({occurrences} occurrences replaced)" : "";
            return $"Edited \"{path}\"{occurrenceNote}. Surrounding text now reads: …{snippet}…";
        });
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        if (needle.Length == 0) return 0;
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) != -1)
        {
            count++;
            index += needle.Length;
        }
        return count;
    }

    private static string ReplaceFirst(string haystack, string needle, string replacement)
    {
        var index = haystack.IndexOf(needle, StringComparison.Ordinal);
        return index < 0 ? haystack : haystack[..index] + replacement + haystack[(index + needle.Length)..];
    }

    private static string Truncate(string text, int maxChars) =>
        text.Length <= maxChars ? text : text[..maxChars] + "… (truncated)";

    private static string SnippetAround(string text, string anchor, int contextChars)
    {
        var index = text.IndexOf(anchor, StringComparison.Ordinal);
        if (index < 0) return Truncate(text, contextChars * 2);
        var start = Math.Max(0, index - contextChars);
        var end = Math.Min(text.Length, index + anchor.Length + contextChars);
        return text[start..end];
    }
}
