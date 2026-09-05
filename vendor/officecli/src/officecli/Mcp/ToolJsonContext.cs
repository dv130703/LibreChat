// Copyright 2026 OfficeCLI (https://OfficeCLI.AI)
// SPDX-License-Identifier: Apache-2.0

using System.Text.Json.Serialization;

namespace OfficeCli.Mcp;

/// <summary>
/// Source-generated JSON contract for the tool PARAMETER/return types this
/// project introduces beyond the primitives System.Text.Json already handles
/// natively (string, int, bool, ...). Kept separate from the document
/// engine's own <see cref="OfficeCli.Core.AppJsonContext"/> since it serves a
/// different serializer pipeline (the MCP SDK's argument marshalling, not the
/// CLI's own JSON output). Required because this project ships
/// PublishTrimmed=true: the SDK's tool-argument binding needs a
/// JsonTypeInfoResolver that can describe every parameter type without
/// runtime reflection, and a generic type like Dictionary&lt;string, string&gt;
/// (used by add_element/set_properties for `properties`) is not covered by
/// any resolver supplied by default.
/// </summary>
[JsonSerializable(typeof(Dictionary<string, string>))]
internal partial class ToolJsonContext : JsonSerializerContext;
