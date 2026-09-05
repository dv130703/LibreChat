// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using OfficeCli.Core;
using OfficeCli.Mcp;
using Xunit;

namespace OfficeCli.Tests;

public sealed class PathGuardTests : IDisposable
{
    private readonly string _workDir;

    public PathGuardTests()
    {
        _workDir = Directory.CreateTempSubdirectory("officecli-pathguard-test-").FullName;
        Directory.SetCurrentDirectory(_workDir);
    }

    public void Dispose() => Directory.Delete(_workDir, recursive: true);

    [Theory]
    [InlineData("report.docx")]
    [InlineData("subdir/report.docx")]
    [InlineData("./report.docx")]
    public void ResolvesOrdinaryRelativePathsInsideTheWorkspace(string relativePath)
    {
        var resolved = PathGuard.ResolveWithinWorkspace(relativePath);

        Assert.StartsWith(_workDir, resolved);
    }

    [Theory]
    [InlineData("../escape.docx")]
    [InlineData("../../etc/passwd")]
    [InlineData("subdir/../../escape.docx")]
    public void RejectsPathsThatEscapeTheWorkspaceViaTraversal(string escapingPath)
    {
        var ex = Assert.Throws<CliException>(() => PathGuard.ResolveWithinWorkspace(escapingPath));

        Assert.Equal("path_traversal", ex.Code);
    }

    [Fact]
    public void RejectsAnAbsolutePathOutsideTheWorkspace()
    {
        var ex = Assert.Throws<CliException>(() => PathGuard.ResolveWithinWorkspace("/etc/passwd"));

        Assert.Equal("path_traversal", ex.Code);
    }

    [Fact]
    public void RejectsAnEmptyPath()
    {
        var ex = Assert.Throws<CliException>(() => PathGuard.ResolveWithinWorkspace(""));

        Assert.Equal("invalid_value", ex.Code);
    }
}
