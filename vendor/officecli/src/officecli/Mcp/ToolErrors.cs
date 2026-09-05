// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using Microsoft.Extensions.Logging;
using ModelContextProtocol;
using OfficeCli.Core;

namespace OfficeCli.Mcp;

/// <summary>
/// Every tool method funnels its body through <see cref="Run"/>/<see cref="RunAsync"/>
/// so error handling is identical everywhere: a <see cref="CliException"/>'s
/// structured Code/Suggestion/Help fields are folded into one natural-language,
/// recovery-oriented message; any other exception is logged with full detail
/// server-side and surfaced to the model only as a generic, non-leaky message.
/// Throwing <see cref="McpException"/> is the SDK-documented way to produce a
/// clean `isError: true` CallToolResult carrying just the message — never a
/// stack trace.
/// </summary>
public static class ToolErrors
{
    public static async Task<string> RunAsync(ILogger logger, string toolName, Func<Task<string>> body)
    {
        try
        {
            return await body();
        }
        catch (McpException)
        {
            throw; // Already a clean, intentional tool-facing error — pass through.
        }
        catch (CliException ex)
        {
            logger.LogWarning(ex, "{Tool} failed: {Message}", toolName, ex.Message);
            throw new McpException(Format(ex));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "{Tool} threw an unexpected exception", toolName);
            throw new McpException($"{toolName} failed unexpectedly: {ex.Message}");
        }
    }

    public static string Run(ILogger logger, string toolName, Func<string> body) =>
        RunAsync(logger, toolName, () => Task.FromResult(body())).GetAwaiter().GetResult();

    /// <summary>
    /// Renders a <see cref="CliException"/> as one natural-language paragraph:
    /// the message, then a recovery path built from whichever of
    /// Suggestion/Help/ValidValues the exception carries. Anthropic's own
    /// tool-design guidance calls for exactly this shape — an error that
    /// tells the model what went wrong AND what to try next, not just a
    /// bare failure.
    /// </summary>
    private static string Format(CliException ex)
    {
        var parts = new List<string> { ex.Message };
        if (!string.IsNullOrWhiteSpace(ex.Suggestion))
            parts.Add($"Suggestion: {ex.Suggestion}");
        if (ex.ValidValues is { Length: > 0 })
            parts.Add($"Valid values: {string.Join(", ", ex.ValidValues)}");
        if (!string.IsNullOrWhiteSpace(ex.Help))
            parts.Add($"For more detail, run: {ex.Help}");
        return string.Join(" ", parts);
    }
}
