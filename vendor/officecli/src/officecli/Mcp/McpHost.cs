// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OfficeCli.Mcp.Tools;

namespace OfficeCli.Mcp;

/// <summary>
/// Entry point for the MCP stdio server, built on the official
/// ModelContextProtocol C# SDK (github.com/modelcontextprotocol/csharp-sdk)
/// instead of a hand-rolled JSON-RPC loop. Tool discovery, lifecycle
/// (initialize/initialized/tools list/call), and stdio framing are all
/// handled by the SDK; this file only wires configuration, logging, and the
/// tool assembly together.
/// </summary>
public static class McpHost
{
    public static async Task<int> RunAsync()
    {
        var options = McpServerOptions.FromEnvironment();

        var builder = Host.CreateApplicationBuilder();

        // stdio IS the JSON-RPC transport for this server — anything written to
        // stdout that isn't a protocol message corrupts the stream. Logs MUST go
        // to stderr, never the console's default (stdout) sink. This mirrors the
        // official SDK's own QuickstartWeatherServer sample.
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole(consoleOptions =>
        {
            consoleOptions.LogToStandardErrorThreshold = LogLevel.Trace;
        });
        builder.Logging.SetMinimumLevel(options.LogLevel);

        // Tool argument marshalling needs a JsonTypeInfoResolver that can describe
        // every parameter type WITHOUT runtime reflection (this project ships
        // PublishTrimmed=true). The SDK's own default resolver chain covers
        // primitives and its own protocol types but not this project's tool
        // parameter types (e.g. Dictionary<string, string>) — combine ours in via
        // the documented JsonTypeInfoResolver.Combine rather than falling back to
        // reflection-based serialization.
        var toolSerializerOptions = new JsonSerializerOptions(AIJsonUtilities.DefaultOptions)
        {
            TypeInfoResolver = JsonTypeInfoResolver.Combine(
                ToolJsonContext.Default,
                AIJsonUtilities.DefaultOptions.TypeInfoResolver),
        };

        // Each tool class is registered individually via the generic WithTools<T>
        // rather than WithToolsFromAssembly: the assembly-scanning overload needs
        // reflection over method metadata (RequiresUnreferencedCode / IL2026) and
        // is documented by the SDK itself as unsafe under trimming/Native AOT —
        // this project publishes with PublishTrimmed=true, so the generic,
        // trim-safe registration is the correct one here even though it means
        // listing each tool class by hand.
        builder.Services
            .AddMcpServer()
            .WithStdioServerTransport()
            .WithTools<CreateDocumentTool>(toolSerializerOptions)
            .WithTools<ReadDocumentTool>(toolSerializerOptions)
            .WithTools<GetElementTool>(toolSerializerOptions)
            .WithTools<QueryElementsTool>(toolSerializerOptions)
            .WithTools<AddElementTool>(toolSerializerOptions)
            .WithTools<EditTextTool>(toolSerializerOptions)
            .WithTools<SetPropertiesTool>(toolSerializerOptions)
            .WithTools<RemoveElementTool>(toolSerializerOptions)
            .WithTools<ValidateDocumentTool>(toolSerializerOptions)
            .WithTools<ViewIssuesTool>(toolSerializerOptions)
            .WithTools<GetSchemaHelpTool>(toolSerializerOptions);

        var host = builder.Build();
        var logger = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("OfficeCli.Mcp");
        logger.LogInformation(
            "officecli MCP server starting (working directory: {Cwd}, log level: {LogLevel})",
            Directory.GetCurrentDirectory(), options.LogLevel);

        // Host.RunAsync() already installs SIGINT/SIGTERM handlers that trigger
        // IHostApplicationLifetime and await graceful shutdown of all registered
        // services. There is no other long-lived resource here to close: every
        // tool in Mcp/Tools opens its IDocumentHandler, performs one operation,
        // and disposes it within the same call — there is no resident session,
        // open file handle, or background task outliving a single tool call for
        // this server to clean up on exit.
        try
        {
            await host.RunAsync();
            return 0;
        }
        catch (Exception ex)
        {
            logger.LogCritical(ex, "officecli MCP server terminated unexpectedly");
            return 1;
        }
    }
}
