// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Extensions.Logging.Abstractions;
using ModelContextProtocol;
using OfficeCli.Mcp.Tools;
using Xunit;

namespace OfficeCli.Tests;

public sealed class CreateDocumentToolTests : IDisposable
{
    private readonly string _workDir;
    private readonly CreateDocumentTool _tool = new(NullLogger<CreateDocumentTool>.Instance);

    public CreateDocumentToolTests()
    {
        _workDir = Directory.CreateTempSubdirectory("officecli-create-test-").FullName;
        Directory.SetCurrentDirectory(_workDir);
    }

    public void Dispose() => Directory.Delete(_workDir, recursive: true);

    [Theory]
    [InlineData("report.docx")]
    [InlineData("budget.xlsx")]
    [InlineData("deck.pptx")]
    public void CreatesABlankDocumentForEachSupportedFormat(string fileName)
    {
        var result = _tool.CreateDocument(fileName, overwrite: false);

        Assert.Contains("Created", result);
        Assert.True(File.Exists(Path.Combine(_workDir, fileName)));
    }

    [Fact]
    public void RefusesToOverwriteAnExistingFileByDefault()
    {
        _tool.CreateDocument("report.docx");
        var before = File.ReadAllBytes(Path.Combine(_workDir, "report.docx"));

        var ex = Assert.Throws<McpException>(() => _tool.CreateDocument("report.docx"));

        Assert.Contains("already exists", ex.Message);
        Assert.Contains("overwrite", ex.Message);
        // The refusal must be a true no-op — the original bytes are untouched.
        Assert.Equal(before, File.ReadAllBytes(Path.Combine(_workDir, "report.docx")));
    }

    [Fact]
    public void OverwriteTrueReplacesAnExistingFile()
    {
        _tool.CreateDocument("report.docx");

        var result = _tool.CreateDocument("report.docx", overwrite: true);

        Assert.Contains("Created", result);
        Assert.True(File.Exists(Path.Combine(_workDir, "report.docx")));
    }
}
