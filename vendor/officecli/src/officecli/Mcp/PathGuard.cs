// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using OfficeCli.Core;

namespace OfficeCli.Mcp;

/// <summary>
/// Defense-in-depth path validation for every MCP tool that accepts a
/// <c>file_path</c> parameter. The MCP host process is normally already
/// confined to a per-user workspace directory by the caller (e.g. an OS-level
/// sandbox), but that confinement lives OUTSIDE this process — a tool
/// implementation must not assume it and should independently refuse to
/// resolve outside the current working directory. This mirrors the identical
/// check LibreChat's own integration performs on its side
/// (packages/api/src/files/office/detect.ts, resolveWorkspacePath).
/// </summary>
public static class PathGuard
{
    /// <summary>
    /// Resolves <paramref name="filePath"/> against the current working
    /// directory and throws a <see cref="CliException"/> (caught uniformly by
    /// <see cref="ToolErrors"/>) if the resolved path escapes it via `..` or
    /// is rooted outside of it.
    /// </summary>
    public static string ResolveWithinWorkspace(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            throw new CliException("file_path is required and cannot be empty.")
            {
                Code = "invalid_value",
                Suggestion = "Pass a relative path such as \"report.docx\"."
            };
        }

        var workspaceRoot = Path.GetFullPath(Directory.GetCurrentDirectory());
        var resolved = Path.GetFullPath(Path.Combine(workspaceRoot, filePath));

        // Path.GetFullPath already collapses ".." segments; comparing the
        // resolved path's prefix against the workspace root after that
        // collapse is what actually catches an escape attempt (a raw string
        // search for ".." would both miss encoded/absolute-path escapes and
        // false-positive on a legitimate filename that merely contains dots).
        var relative = Path.GetRelativePath(workspaceRoot, resolved);
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative))
        {
            throw new CliException(
                $"Path traversal rejected: \"{filePath}\" resolves outside the working directory.")
            {
                Code = "path_traversal",
                Suggestion = "Use a relative path inside the current working directory, e.g. \"report.docx\" or \"reports/q3.xlsx\"."
            };
        }

        return resolved;
    }
}
