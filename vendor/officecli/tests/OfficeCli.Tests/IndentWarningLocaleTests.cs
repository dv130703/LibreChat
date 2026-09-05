// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol;
using OfficeCli.Mcp.Tools;
using Xunit;

namespace OfficeCli.Tests;

/// <summary>
/// Regression coverage for a real production trace: a plain English memo
/// tripped "Body paragraph missing first-line indent" on every body
/// paragraph — a CJK manuscript convention, not an English one — and then
/// set_properties rejected the suggested fix ("2 characters") with an error
/// naming the wrong property ("spacing") and irrelevant example units
/// ('1.5x'/'150%', which only apply to line spacing). The model burned most
/// of a 21-tool-call turn on this one warning before landing on an
/// unrelated, ineffective property by chance.
/// </summary>
public sealed class IndentWarningLocaleTests : IDisposable
{
    private readonly string _workDir;
    private readonly CreateDocumentTool _createTool = new(NullLogger<CreateDocumentTool>.Instance);
    private readonly AddElementTool _addTool = new(NullLogger<AddElementTool>.Instance);
    private readonly SetPropertiesTool _setTool = new(NullLogger<SetPropertiesTool>.Instance);
    private readonly ViewIssuesTool _viewTool = new(NullLogger<ViewIssuesTool>.Instance);

    public IndentWarningLocaleTests()
    {
        _workDir = Directory.CreateTempSubdirectory("officecli-indent-locale-test-").FullName;
        Directory.SetCurrentDirectory(_workDir);
    }

    public void Dispose() => Directory.Delete(_workDir, recursive: true);

    [Fact]
    public void AnEnglishBodyParagraphIsNotFlaggedForMissingFirstLineIndent()
    {
        _createTool.CreateDocument("memo.docx");
        _addTool.AddElement("memo.docx", parent_path: "/body", type: "paragraph",
            properties: new Dictionary<string, string> { ["text"] = "This memo provides an overview of the current status." });

        var result = _viewTool.ViewIssues("memo.docx");

        Assert.DoesNotContain("first-line indent", result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ACjkBodyParagraphIsStillFlaggedWithAnActionableSuggestion()
    {
        _createTool.CreateDocument("memo.docx");
        _addTool.AddElement("memo.docx", parent_path: "/body", type: "paragraph",
            properties: new Dictionary<string, string> { ["text"] = "这是一份项目状态备忘录，介绍当前的进展情况。" });

        var result = _viewTool.ViewIssues("memo.docx");

        Assert.Contains("first-line indent", result, StringComparison.OrdinalIgnoreCase);
        // The suggestion must name the real property (firstLineChars) so the
        // model doesn't have to guess units/names blind, unlike before.
        Assert.Contains("firstLineChars", result);
    }

    [Fact]
    public void SetPropertiesRejectsABadFirstLineIndentUnitWithTheRealPropertyNameNotSpacing()
    {
        _createTool.CreateDocument("memo.docx");
        _addTool.AddElement("memo.docx", parent_path: "/body", type: "paragraph",
            properties: new Dictionary<string, string> { ["text"] = "Body text." });

        var ex = Assert.Throws<McpException>(() =>
            _setTool.SetProperties("memo.docx", "/body/p[1]", new Dictionary<string, string> { ["firstLineIndent"] = "2char" }));

        // Previously this said `Invalid 'spacing' value ...` regardless of
        // which property actually failed, and suggested '1.5x'/'150%' units
        // that firstLineIndent doesn't even accept.
        Assert.Contains("firstLineIndent", ex.Message);
        Assert.DoesNotContain("'spacing'", ex.Message);
        Assert.DoesNotContain("1.5x", ex.Message);
    }

    [Fact]
    public void SetPropertiesAcceptsFirstLineCharsAsAPlainInteger()
    {
        _createTool.CreateDocument("memo.docx");
        _addTool.AddElement("memo.docx", parent_path: "/body", type: "paragraph",
            properties: new Dictionary<string, string> { ["text"] = "这是正文段落。" });

        var result = _setTool.SetProperties("memo.docx", "/body/p[1]", new Dictionary<string, string> { ["firstLineChars"] = "2" });

        Assert.Contains("Updated", result);
        Assert.DoesNotContain("Unsupported", result, StringComparison.OrdinalIgnoreCase);
    }
}
