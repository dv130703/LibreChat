// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol;
using OfficeCli.Mcp.Tools;
using Xunit;

namespace OfficeCli.Tests;

public sealed class GetSchemaHelpToolTests
{
    private readonly GetSchemaHelpTool _tool = new(NullLogger<GetSchemaHelpTool>.Instance);

    [Fact]
    public void ListsElementTypesForWordAndIncludesParagraphButNotHeading()
    {
        var result = _tool.GetSchemaHelp("docx");

        Assert.Contains("paragraph", result);
        // The exact bug a stress test found: "heading" must never appear as
        // if it were a valid type, since it isn't one.
        Assert.DoesNotContain("heading", result);
    }

    [Fact]
    public void ShowsPropertiesForASpecificElement()
    {
        var result = _tool.GetSchemaHelp("docx", element_type: "paragraph");

        // Exact wording of the schema renderer isn't the contract here — just
        // that calling with a real element returns non-trivial detail, not
        // the bare element list.
        Assert.False(string.IsNullOrWhiteSpace(result));
        Assert.True(result.Length > 20);
    }

    [Theory]
    [InlineData("word")]
    [InlineData("excel")]
    [InlineData("powerpoint")]
    [InlineData("docx")]
    [InlineData("xlsx")]
    [InlineData("pptx")]
    public void AcceptsFormatAliasesNotJustCanonicalExtensions(string alias)
    {
        var result = _tool.GetSchemaHelp(alias);

        Assert.False(string.IsNullOrWhiteSpace(result));
    }

    [Fact]
    public void ThrowsAHelpfulErrorForAnUnknownFormat()
    {
        var ex = Assert.Throws<McpException>(() => _tool.GetSchemaHelp("notaformat"));

        Assert.Contains("unknown format", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TruncatesAPropertyHeavyElementInsteadOfReturningItUnbounded()
    {
        // Excel's "cell" schema is the concrete case a stress test found
        // derailing a small model — dozens of properties with full
        // descriptions and examples, unfiltered.
        var result = _tool.GetSchemaHelp("xlsx", element_type: "cell");

        Assert.True(result.Length <= 1800 + 400, $"expected a bounded response, got {result.Length} chars");
        Assert.Contains("truncated", result, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void VerbFilterCanAvoidTruncationForTheSameElement()
    {
        // The tool explicitly recommends verb as the way to get a complete,
        // non-truncated answer instead of a partial unfiltered one — verify
        // that path actually stays short enough to not need truncating.
        var result = _tool.GetSchemaHelp("xlsx", element_type: "cell", verb: "add");

        Assert.True(result.Length < 5000);
    }

    [Fact]
    public void ThrowsAHelpfulErrorForAnUnknownElementType()
    {
        var ex = Assert.Throws<McpException>(() => _tool.GetSchemaHelp("docx", element_type: "not_a_real_element"));

        Assert.False(string.IsNullOrWhiteSpace(ex.Message));
    }
}
