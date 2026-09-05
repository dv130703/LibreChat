// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Extensions.Logging;

namespace OfficeCli.Mcp;

/// <summary>
/// Server-level settings, externalized as environment variables (there is no
/// config file for the MCP entry point — it is spawned fresh per session by
/// the MCP client, so process environment is the natural place for this).
/// Validated eagerly at startup rather than read ad hoc, so a typo'd value
/// fails fast with a clear message instead of silently falling back partway
/// through a tool call.
/// </summary>
public sealed record McpServerOptions(LogLevel LogLevel)
{
    private const string LogLevelVar = "OFFICECLI_MCP_LOG_LEVEL";

    public static McpServerOptions FromEnvironment()
    {
        var raw = Environment.GetEnvironmentVariable(LogLevelVar);
        if (string.IsNullOrWhiteSpace(raw))
            return new McpServerOptions(LogLevel.Information);

        if (!Enum.TryParse<LogLevel>(raw, ignoreCase: true, out var level))
        {
            var validValues = string.Join(", ", Enum.GetNames<LogLevel>());
            throw new InvalidOperationException(
                $"Invalid {LogLevelVar} value \"{raw}\". Valid values: {validValues}.");
        }

        return new McpServerOptions(level);
    }
}
