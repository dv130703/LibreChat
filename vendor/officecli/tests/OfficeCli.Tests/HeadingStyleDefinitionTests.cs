// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using Microsoft.Extensions.Logging.Abstractions;
using OfficeCli.Mcp.Tools;
using Xunit;

namespace OfficeCli.Tests;

/// <summary>
/// Regression coverage for BUG-STYLE-UNDEFINED: a fresh .docx used to define
/// only the "Normal" style, so a paragraph created via
/// add_element(type="paragraph", properties={"style":"Heading1"}) — the
/// engine's own documented way to make a heading — referenced a style id
/// that was never defined anywhere in the file. A style referenced but not
/// defined renders as plain body text (in real Word too, not just this
/// engine's own preview), so every "heading" a model produced this way came
/// out visually identical to a normal paragraph.
/// </summary>
public sealed class HeadingStyleDefinitionTests : IDisposable
{
    private readonly string _workDir;
    private readonly CreateDocumentTool _createTool = new(NullLogger<CreateDocumentTool>.Instance);
    private readonly AddElementTool _addTool = new(NullLogger<AddElementTool>.Instance);

    public HeadingStyleDefinitionTests()
    {
        _workDir = Directory.CreateTempSubdirectory("officecli-heading-style-test-").FullName;
        Directory.SetCurrentDirectory(_workDir);
    }

    public void Dispose() => Directory.Delete(_workDir, recursive: true);

    [Theory]
    [InlineData("Heading1")]
    [InlineData("Heading2")]
    [InlineData("Heading3")]
    [InlineData("Title")]
    public void AFreshDocumentAlreadyDefinesTheStandardBuiltInStyles(string styleId)
    {
        _createTool.CreateDocument("report.docx");

        using var doc = WordprocessingDocument.Open(Path.Combine(_workDir, "report.docx"), isEditable: false);
        var styles = doc.MainDocumentPart!.StyleDefinitionsPart!.Styles!;

        var style = styles.Elements<Style>().FirstOrDefault(s => s.StyleId == styleId);
        Assert.True(style != null, $"Expected \"{styleId}\" to be defined in a fresh document's styles.xml, but it was missing.");
    }

    [Fact]
    public void AHeadingParagraphActuallyCarriesVisibleFormattingNotJustAStyleReference()
    {
        _createTool.CreateDocument("report.docx");
        _addTool.AddElement(
            "report.docx",
            parent_path: "/body",
            type: "paragraph",
            properties: new Dictionary<string, string> { ["style"] = "Heading1", ["text"] = "My Title" });

        using var doc = WordprocessingDocument.Open(Path.Combine(_workDir, "report.docx"), isEditable: false);
        var styles = doc.MainDocumentPart!.StyleDefinitionsPart!.Styles!;
        var heading1 = styles.Elements<Style>().Single(s => s.StyleId == "Heading1");

        // The exact defect: previously Heading1 had no <w:style> entry at
        // all, so nothing below could ever be asserted. Now it must carry
        // real, visible run formatting — not just exist as a bare reference.
        var runProps = heading1.StyleRunProperties;
        Assert.NotNull(runProps);
        Assert.NotNull(runProps!.Bold);
        Assert.NotNull(runProps.FontSize);
        Assert.True(int.Parse(runProps.FontSize!.Val!.Value!) > 22, "Heading1 should render larger than the 11pt (sz=22) body default.");

        // And the paragraph itself must actually reference it.
        var body = doc.MainDocumentPart!.Document!.Body!;
        var paragraph = body.Elements<Paragraph>().Single();
        Assert.Equal("Heading1", paragraph.ParagraphProperties?.ParagraphStyleId?.Val?.Value);
    }

    [Fact]
    public void NormalStyleIsUnaffectedAndStillTheDocumentDefault()
    {
        _createTool.CreateDocument("report.docx");

        using var doc = WordprocessingDocument.Open(Path.Combine(_workDir, "report.docx"), isEditable: false);
        var styles = doc.MainDocumentPart!.StyleDefinitionsPart!.Styles!;
        var normal = styles.Elements<Style>().Single(s => s.StyleId == "Normal");

        Assert.True(normal.Default?.Value);
    }
}
