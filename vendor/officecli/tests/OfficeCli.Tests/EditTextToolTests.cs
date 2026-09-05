// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol;
using OfficeCli;
using OfficeCli.Mcp.Tools;
using Xunit;

namespace OfficeCli.Tests;

/// <summary>
/// Exercises edit_text against a REAL .docx on disk (created via the same
/// BlankDocCreator/DocumentHandlerFactory the tool itself uses) rather than
/// a mock — per this project's convention, the document engine's real
/// behavior (path resolution, OOXML round-tripping) is exactly what a mock
/// would hide and these edge cases depend on.
/// </summary>
public sealed class EditTextToolTests : IDisposable
{
    private readonly string _workDir;
    private readonly EditTextTool _tool = new(NullLogger<EditTextTool>.Instance);

    public EditTextToolTests()
    {
        _workDir = Directory.CreateTempSubdirectory("officecli-edittext-test-").FullName;
        Directory.SetCurrentDirectory(_workDir);
    }

    public void Dispose() => Directory.Delete(_workDir, recursive: true);

    private void CreateDocWithParagraph(string text)
    {
        BlankDocCreator.Create("doc.docx");
        using var handler = OfficeCli.Handlers.DocumentHandlerFactory.Open("doc.docx", editable: true);
        handler.Add("/body", "paragraph", null, new Dictionary<string, string> { ["text"] = text });
        handler.Save();
    }

    [Fact]
    public void ReplacesTheOneExactMatch()
    {
        CreateDocWithParagraph("Meeting Summary for Q3");

        var result = _tool.EditText("doc.docx", "/body/p[1]", "Q3", "Q4 2026", replace_all: false);

        Assert.Contains("Edited", result);
        using var handler = OfficeCli.Handlers.DocumentHandlerFactory.Open("doc.docx", editable: false);
        Assert.Equal("Meeting Summary for Q4 2026", handler.Get("/body/p[1]", 1).Text);
    }

    [Fact]
    public void ThrowsAnActionableErrorWhenOldStrIsNotFound()
    {
        CreateDocWithParagraph("Meeting Summary for Q3");

        var ex = Assert.Throws<McpException>(() =>
            _tool.EditText("doc.docx", "/body/p[1]", "definitely not present", "x", replace_all: false));

        // The error must show the model the REAL current text so it can
        // correct old_str itself, not just say "not found".
        Assert.Contains("Meeting Summary for Q3", ex.Message);
    }

    [Fact]
    public void ThrowsWhenOldStrMatchesMultipleLocationsAndReplaceAllIsFalse()
    {
        CreateDocWithParagraph("apple apple banana");

        var ex = Assert.Throws<McpException>(() =>
            _tool.EditText("doc.docx", "/body/p[1]", "apple", "pear", replace_all: false));

        Assert.Contains("2 locations", ex.Message);
        Assert.Contains("replace_all", ex.Message);
    }

    [Fact]
    public void ReplaceAllTrueReplacesEveryOccurrence()
    {
        CreateDocWithParagraph("apple apple banana");

        _tool.EditText("doc.docx", "/body/p[1]", "apple", "pear", replace_all: true);

        using var handler = OfficeCli.Handlers.DocumentHandlerFactory.Open("doc.docx", editable: false);
        Assert.Equal("pear pear banana", handler.Get("/body/p[1]", 1).Text);
    }

    [Fact]
    public void ThrowsWhenTheTargetElementHasNoText()
    {
        BlankDocCreator.Create("doc.docx");
        using (var handler = OfficeCli.Handlers.DocumentHandlerFactory.Open("doc.docx", editable: true))
        {
            handler.Add("/body", "table", null, new Dictionary<string, string> { ["rows"] = "1", ["cols"] = "1" });
            handler.Save();
        }

        var ex = Assert.Throws<McpException>(() =>
            _tool.EditText("doc.docx", "/body/tbl[1]", "x", "y", replace_all: false));

        Assert.Contains("no text content", ex.Message);
    }
}
