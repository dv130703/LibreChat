import { z } from 'zod';
import type { TMessageContentParts, FunctionTool, FunctionToolCall } from './types/assistants';
import type { SearchResultData } from './types/web';
import type { TFile } from './types/files';
import { TFeedback, feedbackSchema } from './feedback';
import { Tools } from './types/assistants';

export const isUUID = z.string().uuid();

export enum AuthType {
  OVERRIDE_AUTH = 'override_auth',
  USER_PROVIDED = 'user_provided',
  SYSTEM_DEFINED = 'system_defined',
}

export const authTypeSchema = z.nativeEnum(AuthType);

export enum EModelEndpoint {
  agents = 'agents',
  custom = 'custom',
}

/**
 * Mirrors `@librechat/agents` providers. Only `OPENAI` is reachable in this
 * Ollama-only deployment (Ollama speaks the OpenAI-compatible API), but the
 * full set is kept since `@librechat/agents` itself still defines and
 * type-checks against these values.
 */
export enum Providers {
  OPENAI = 'openAI',
  ANTHROPIC = 'anthropic',
  AZURE = 'azureOpenAI',
  GOOGLE = 'google',
  VERTEXAI = 'vertexai',
  BEDROCK = 'bedrock',
  MISTRALAI = 'mistralai',
  MISTRAL = 'mistral',
  DEEPSEEK = 'deepseek',
  MOONSHOT = 'moonshot',
  OPENROUTER = 'openrouter',
  XAI = 'xai',
}

/**
 * Endpoints that support direct PDF processing in the agent system.
 * Includes both the client-facing endpoint type (`custom`) and the resolved
 * backend `Providers` value (`Providers.OPENAI`, since Ollama and other
 * OpenAI-compatible custom endpoints resolve to it at request time).
 */
export const documentSupportedProviders = new Set<string>([
  EModelEndpoint.custom,
  Providers.OPENAI,
]);

const openAILikeProviders = new Set<string>([Providers.OPENAI, EModelEndpoint.custom]);

export const isOpenAILikeProvider = (provider?: string | null): boolean => {
  return openAILikeProviders.has(provider ?? '');
};

/**
 * Providers whose `usage_metadata.input_tokens` ALREADY INCLUDES cached tokens
 * (`input_token_details.cache_*` is a subset, not an additional charge) —
 * Google/Vertex (`promptTokenCount`), OpenAI/Azure (`prompt_tokens`), and the
 * OpenAI-compatible family. `@librechat/agents`' `getAnthropicUsageMetadata`
 * folds `cache_creation` + `cache_read` into `input_tokens`, so Anthropic is a
 * subset provider too; without this the cache portion is billed twice. Bedrock
 * stays additive — its Converse path passes AWS `inputTokens` through unmodified.
 * This is a factual statement about how each upstream API/library reports usage,
 * not about which providers LibreChat exposes as native chat endpoints — a
 * custom/Ollama endpoint proxying to any of these APIs (e.g. via OpenRouter)
 * still needs correct cache accounting.
 * Single source of truth shared by the backend billing path
 * (`packages/api/src/agents/usage.ts`) and the client usage normalization.
 */
export const cacheSubsetProviders = new Set<string>([
  Providers.OPENAI,
  Providers.AZURE,
  Providers.GOOGLE,
  Providers.VERTEXAI,
  Providers.XAI,
  Providers.DEEPSEEK,
  Providers.OPENROUTER,
  Providers.MOONSHOT,
  Providers.ANTHROPIC,
]);

export const inputTokensIncludesCache = (provider?: string | null): boolean => {
  return cacheSubsetProviders.has(provider ?? '');
};

export const isDocumentSupportedProvider = (provider?: string | null): boolean => {
  return documentSupportedProviders.has(provider ?? '');
};

export const paramEndpoints = new Set<EModelEndpoint | string>([
  EModelEndpoint.agents,
  EModelEndpoint.custom,
]);

export const getSettingsKeys = (endpoint: EModelEndpoint | string, model: string) => {
  const combinedKey = `${endpoint}-${model}`;
  return [combinedKey, endpoint];
};

export type AgentProvider = Exclude<keyof typeof EModelEndpoint, EModelEndpoint.agents> | string;

export const isAgentsEndpoint = (_endpoint?: EModelEndpoint.agents | null | string): boolean => {
  const endpoint = _endpoint ?? '';
  if (!endpoint) {
    return false;
  }
  return endpoint === EModelEndpoint.agents;
};

export const isParamEndpoint = (
  endpoint: EModelEndpoint | string,
  endpointType?: EModelEndpoint | string,
): boolean => {
  if (paramEndpoints.has(endpoint)) {
    return true;
  }

  if (endpointType != null) {
    return paramEndpoints.has(endpointType);
  }

  return false;
};

export enum ImageDetail {
  low = 'low',
  auto = 'auto',
  high = 'high',
}

export enum ReasoningEffort {
  unset = '',
  none = 'none',
  minimal = 'minimal',
  low = 'low',
  medium = 'medium',
  high = 'high',
  xhigh = 'xhigh',
  max = 'max',
}

export enum ReasoningParameterFormat {
  disabled = 'disabled',
  reasoningEffort = 'reasoning_effort',
  reasoningObject = 'reasoning_object',
}

export enum ReasoningResponseKey {
  reasoning = 'reasoning',
  reasoningContent = 'reasoning_content',
}

export enum AnthropicEffort {
  unset = '',
  low = 'low',
  medium = 'medium',
  high = 'high',
  xhigh = 'xhigh',
  max = 'max',
}

/**
 * Controls whether the model's reasoning content is returned in responses.
 *
 * - `'auto'` - LibreChat decides: opt in to `'summarized'` for models that
 *   omit by default (Opus 4.7+), leave the field off for older models.
 * - `'summarized'` - always request a post-hoc summary of the reasoning.
 * - `'omitted'` - always suppress reasoning content. Slightly lower latency.
 *
 * See https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
 */
export enum ThinkingDisplay {
  auto = 'auto',
  summarized = 'summarized',
  omitted = 'omitted',
}

/**
 * Wire-level values accepted by the Anthropic Messages API `thinking.display`
 * field. Excludes the LibreChat-only `'auto'` sentinel.
 */
export type ThinkingDisplayWireValue = Exclude<ThinkingDisplay, ThinkingDisplay.auto>;

export enum BedrockReasoningConfig {
  low = 'low',
  medium = 'medium',
  high = 'high',
}

export enum ReasoningSummary {
  none = '',
  auto = 'auto',
  concise = 'concise',
  detailed = 'detailed',
}

export enum Verbosity {
  none = '',
  low = 'low',
  medium = 'medium',
  high = 'high',
}

export enum ThinkingLevel {
  unset = '',
  minimal = 'minimal',
  low = 'low',
  medium = 'medium',
  high = 'high',
}

/** OpenAI Responses API `reasoning.mode` (GPT-5.6+). */
export enum ReasoningMode {
  unset = '',
  standard = 'standard',
  pro = 'pro',
}

/** OpenAI Responses API `reasoning.context` (GPT-5.6+). */
export enum ReasoningContext {
  unset = '',
  auto = 'auto',
  current_turn = 'current_turn',
  all_turns = 'all_turns',
}

export const imageDetailNumeric = {
  [ImageDetail.low]: 0,
  [ImageDetail.auto]: 1,
  [ImageDetail.high]: 2,
};

export const imageDetailValue = {
  0: ImageDetail.low,
  1: ImageDetail.auto,
  2: ImageDetail.high,
};

export const eImageDetailSchema = z.nativeEnum(ImageDetail);
export const eReasoningEffortSchema = z.nativeEnum(ReasoningEffort);
export const eReasoningParameterFormatSchema = z.nativeEnum(ReasoningParameterFormat);
export const eReasoningResponseKeySchema = z.nativeEnum(ReasoningResponseKey);
export const eAnthropicEffortSchema = z.nativeEnum(AnthropicEffort);
export const eThinkingDisplaySchema = z.nativeEnum(ThinkingDisplay);
export const eReasoningSummarySchema = z.nativeEnum(ReasoningSummary);
export const eVerbositySchema = z.nativeEnum(Verbosity);
export const eThinkingLevelSchema = z.nativeEnum(ThinkingLevel);
export const eReasoningModeSchema = z.nativeEnum(ReasoningMode);
export const eReasoningContextSchema = z.nativeEnum(ReasoningContext);

export const defaultAgentFormValues = {
  agent: {},
  id: '',
  name: '',
  description: '',
  instructions: '',
  model: '',
  model_parameters: {},
  tools: [],
  tool_options: {},
  provider: {},
  edges: [],
  artifacts: '',
  recursion_limit: undefined,
  [Tools.execute_code]: false,
  [Tools.file_search]: false,
  [Tools.web_search]: false,
  [Tools.memory]: false,
  category: 'general',
  support_contact: {
    name: '',
    email: '',
  },
  /** Optional allowlist. Only applies when `skills_enabled === true`.
   *  Empty/undefined + enabled = full catalog; non-empty + enabled = narrow to ids. */
  skills: undefined as string[] | undefined,
  /** Master toggle for skill use on this agent. `true` activates skills
   *  (full catalog unless `skills` narrows it). Anything else = inactive. */
  skills_enabled: undefined as boolean | undefined,
  /** `undefined` = feature disabled by default (no subagent tool injected). */
  subagents: undefined as
    | { enabled?: boolean; allowSelf?: boolean; agent_ids?: string[] }
    | undefined,
  /** Memory partition: 'agent' isolates memories per (user, agent); default shared pool */
  memory_scope: undefined as MemoryScope | undefined,
};

export const ImageVisionTool: FunctionTool = {
  type: Tools.function,
  [Tools.function]: {
    name: 'image_vision',
    description: 'Get detailed text descriptions for all current image attachments.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export const isImageVisionTool = (tool: FunctionTool | FunctionToolCall) =>
  tool.type === 'function' && tool.function?.name === ImageVisionTool.function?.name;

/**
 * Ollama's real generation options (see the Ollama API's `options` object),
 * ported from the field list previously encoded in the now-removed, unused
 * `OllamaClient`'s `ollamaPayloadSchema`. This is the parameter set for the
 * `custom` endpoint (Ollama is this deployment's only `custom` endpoint).
 */
export const ollamaSettings = {
  model: {
    default: undefined,
  },
  temperature: {
    min: 0 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 0.8 as const,
  },
  top_p: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 0.9 as const,
  },
  top_k: {
    min: 0 as const,
    max: 100 as const,
    step: 1 as const,
    default: 40 as const,
  },
  num_ctx: {
    min: 0 as const,
    max: 131072 as const,
    step: 1 as const,
    default: 2048 as const,
  },
  num_predict: {
    min: -2 as const,
    max: 131072 as const,
    step: 1 as const,
    /** `-1` = generate until the model stops or the context is full. */
    default: -1 as const,
  },
  repeat_penalty: {
    min: 0 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 1.1 as const,
  },
  repeat_last_n: {
    min: -1 as const,
    max: 2048 as const,
    step: 1 as const,
    default: 64 as const,
  },
  mirostat: {
    min: 0 as const,
    max: 2 as const,
    step: 1 as const,
    default: 0 as const,
  },
  mirostat_eta: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 0.1 as const,
  },
  mirostat_tau: {
    min: 0 as const,
    max: 10 as const,
    step: 0.1 as const,
    default: 5 as const,
  },
  tfs_z: {
    min: 0 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  seed: {
    default: undefined,
  },
  stop: {
    default: undefined,
  },
  resendFiles: {
    default: true as const,
  },
  maxContextTokens: {
    default: undefined,
  },
};

export const agentsSettings = {
  model: {
    default: 'gpt-3.5-turbo-test' as const,
  },
  temperature: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  top_p: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  presence_penalty: {
    min: -2 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 0 as const,
  },
  frequency_penalty: {
    min: -2 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 0 as const,
  },
  resendFiles: {
    default: true as const,
  },
  maxContextTokens: {
    default: undefined,
  },
  max_tokens: {
    default: undefined,
  },
  imageDetail: {
    default: ImageDetail.auto as const,
  },
};

export const endpointSettings = {
  [EModelEndpoint.agents]: agentsSettings,
  [EModelEndpoint.custom]: ollamaSettings,
};

export const eModelEndpointSchema = z.nativeEnum(EModelEndpoint);

export const extendedModelEndpointSchema = z.union([eModelEndpointSchema, z.string()]);

export const tPluginAuthConfigSchema = z.object({
  authField: z.string(),
  label: z.string(),
  description: z.string(),
  optional: z.boolean().optional(),
  /** Whether the field holds a secret and should be masked in the UI (defaults to masked when omitted). */
  sensitive: z.boolean().optional(),
});

export type TPluginAuthConfig = z.infer<typeof tPluginAuthConfigSchema>;

export const tPluginSchema = z.object({
  name: z.string(),
  pluginKey: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  authConfig: z.array(tPluginAuthConfigSchema).optional(),
  authenticated: z.boolean().optional(),
  chatMenu: z.boolean().optional(),
  isButton: z.boolean().optional(),
  toolkit: z.boolean().optional(),
});

export type TPlugin = z.infer<typeof tPluginSchema>;

export type TInput = {
  inputStr: string;
};

export const tExampleSchema = z.object({
  input: z.object({
    content: z.string(),
  }),
  output: z.object({
    content: z.string(),
  }),
});

export type TExample = z.infer<typeof tExampleSchema>;

export const tMessageSchema = z.object({
  messageId: z.string(),
  endpoint: z.string().optional(),
  clientId: z.string().nullable().optional(),
  conversationId: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  responseMessageId: z.string().nullable().optional(),
  overrideParentMessageId: z.string().nullable().optional(),
  bg: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  title: z.string().nullable().or(z.literal('New Chat')).default('New Chat'),
  sender: z.string().optional(),
  text: z.string(),
  /** @deprecated */
  generation: z.string().nullable().optional(),
  isCreatedByUser: z.boolean(),
  isTemporary: z.boolean().optional(),
  expiredAt: z.string().nullable().optional(),
  error: z.boolean().optional(),
  clientTimestamp: z.string().optional(),
  createdAt: z
    .string()
    .optional()
    .default(() => new Date().toISOString()),
  updatedAt: z
    .string()
    .optional()
    .default(() => new Date().toISOString()),
  current: z.boolean().optional(),
  unfinished: z.boolean().optional(),
  searchResult: z.boolean().optional(),
  finish_reason: z.string().optional(),
  /* assistant */
  thread_id: z.string().optional(),
  /* frontend components */
  iconURL: z.string().nullable().optional(),
  feedback: feedbackSchema.optional(),
  /** metadata */
  metadata: z.record(z.unknown()).optional(),
  /** Output tokens for assistant messages, calibrated prompt-side estimate for user messages */
  tokenCount: z.number().optional(),
  contextMeta: z
    .object({
      calibrationRatio: z
        .number()
        .optional()
        .describe(
          'EMA ratio of provider-reported vs local token estimates; seeds the pruner on subsequent runs',
        ),
      encoding: z
        .string()
        .optional()
        .describe(
          'Tokenizer encoding used when this ratio was computed (e.g. "claude", "o200k_base")',
        ),
    })
    .optional(),
  /**
   * Skill names the user invoked manually via the `$` popover on this turn.
   * Purely UI metadata — `SkillPills` renders these above the message
   * bubble so users can see which skills they asked for in history and on
   * reload. Runtime resolution uses the top-level payload field with the
   * same name. Empty / absent for model-invoked skills (shown as tool_call
   * content parts on the assistant message instead).
   */
  manualSkills: z.array(z.string()).optional(),
  /**
   * Skill names auto-primed on this turn because their `always-apply`
   * frontmatter flag is set. Persisted at turn time so the pinned-variant
   * pills on the user bubble survive reload and stay stable across later
   * edits to the skill's `alwaysApply` flag (the user bubble reflects
   * what actually ran, not the current catalog).
   */
  alwaysAppliedSkills: z.array(z.string()).optional(),
  /**
   * Verbatim excerpts the user quoted (via the "Add to chat" selection
   * popup) to reference on this turn. UI metadata that `MessageQuotes`
   * renders above the user bubble so the references persist on reload. The
   * excerpts are merged into the user message text sent to the model at
   * request time and counted in the user message token count.
   */
  quotes: z.array(z.string()).optional(),
});

/**
 * Which memory partition an agent reads/writes.
 * `user` = the shared personal pool (default); `agent` = a partition
 * isolated per (user, agent) so the agent only sees its own memories.
 */
export enum MemoryScope {
  user = 'user',
  agent = 'agent',
}

export type MemoryArtifact = {
  key: string;
  value?: string;
  tokenCount?: number;
  type: 'update' | 'delete' | 'error';
  /** Agent partition the write targeted; absent = shared personal pool */
  agentId?: string;
};

export type UIResource = {
  resourceId: string;
  uri: string;
  mimeType?: string;
  text?: string;
  [key: string]: unknown;
};

export type TAttachmentMetadata = {
  type?: Tools;
  messageId: string;
  toolCallId: string;
  [Tools.memory]?: MemoryArtifact;
  [Tools.ui_resources]?: UIResource[];
  [Tools.web_search]?: SearchResultData;
  [Tools.file_search]?: SearchResultData;
};

export type TAttachment =
  | (TFile & TAttachmentMetadata)
  | (Pick<TFile, 'filename' | 'filepath' | 'conversationId'> & {
      expiresAt: number;
    } & TAttachmentMetadata)
  | (Partial<Pick<TFile, 'filename' | 'filepath'>> &
      Pick<TFile, 'conversationId'> &
      TAttachmentMetadata);

export type TMessage = z.input<typeof tMessageSchema> & {
  children?: TMessage[];
  content?: TMessageContentParts[];
  files?: Partial<TFile>[];
  depth?: number;
  siblingIndex?: number;
  attachments?: TAttachment[];
  clientTimestamp?: string;
  feedback?: TFeedback;
};

export const coerceNumber = z.union([z.number(), z.string()]).transform((val) => {
  if (typeof val === 'string') {
    return val.trim() === '' ? undefined : parseFloat(val);
  }
  return val;
});

type DocumentTypeValue =
  | null
  | boolean
  | number
  | string
  | DocumentTypeValue[]
  | { [key: string]: DocumentTypeValue };

const DocumentType: z.ZodType<DocumentTypeValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(z.lazy(() => DocumentType)),
    z.record(z.lazy(() => DocumentType)),
  ]),
);

export const tConversationSchema = z.object({
  conversationId: z.string().nullable(),
  endpoint: eModelEndpointSchema.nullable(),
  endpointType: eModelEndpointSchema.nullable().optional(),
  isArchived: z.boolean().optional(),
  pinned: z.boolean().optional(),
  /** Audio Transcriber only: how this conversation's transcript was produced.
   *  `model` is what the ASR server actually loaded, which is the only
   *  reliable answer when the request left the model on "auto". */
  transcription: z
    .object({
      model: z.string().optional(),
      // Nullable, not just optional: the RAG server reports this as JSON
      // `null` (not an absent key) whenever a request left the model on
      // "auto", and conversations transcribed before that was normalized to
      // `undefined` on write (see `buildTranscriptionMeta`) already have the
      // literal `null` persisted - tolerating it here is what keeps reading
      // those older conversations from throwing, not just new ones.
      requestedModel: z.string().nullable().optional(),
      language: z.string().optional(),
      diarize: z.boolean().optional(),
      speakerCount: z.number().optional(),
      clusteringThreshold: z.number().optional(),
      includeTimestamps: z.boolean().optional(),
      contextTerms: z.string().optional(),
      suppressNumerals: z.boolean().optional(),
      /** Whether the user accepted channel-based speaker separation for this
       *  recording after being notified it has multiple audio channels. */
      channelSplit: z.boolean().optional(),
      /** What actually produced the speaker labels - `"pyannote"` or
       *  `"channel_split"` - from the transcription response's own
       *  diagnostics, not just the request's intent. */
      diarizationBackend: z.string().optional(),
    })
    .optional(),
  title: z.string().nullable().or(z.literal('New Chat')).default('New Chat'),
  user: z.string().optional(),
  messages: z.array(z.string()).optional(),
  tools: z.union([z.array(tPluginSchema), z.array(z.string())]).optional(),
  modelLabel: z.string().nullable().optional(),
  userLabel: z.string().optional(),
  model: z.string().nullable().optional(),
  promptPrefix: z.string().nullable().optional(),
  temperature: z.number().nullable().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  parentMessageId: z.string().optional(),
  maxOutputTokens: coerceNumber.nullable().optional(),
  maxContextTokens: coerceNumber.optional(),
  max_tokens: coerceNumber.optional(),
  /* Anthropic */
  promptCache: z.boolean().optional(),
  promptCacheTtl: z.enum(['5m', '1h']).optional(),
  system: z.string().optional(),
  thinking: z.boolean().optional(),
  thinkingBudget: coerceNumber.optional(),
  thinkingLevel: eThinkingLevelSchema.optional(),
  stream: z.boolean().optional(),
  /* artifacts */
  artifacts: z.string().optional(),
  /* google */
  context: z.string().nullable().optional(),
  examples: z.array(tExampleSchema).optional(),
  /* DB */
  tags: z.array(z.string()).optional(),
  chatProjectId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /* Files */
  resendFiles: z.boolean().optional(),
  file_ids: z.array(z.string()).optional(),
  /* vision */
  imageDetail: eImageDetailSchema.optional(),
  /* OpenAI: Reasoning models only */
  reasoning_effort: eReasoningEffortSchema.optional().nullable(),
  reasoning_summary: eReasoningSummarySchema.optional().nullable(),
  /* OpenAI Responses API: reasoning mode (standard/pro) + context */
  reasoning_mode: eReasoningModeSchema.optional().nullable(),
  reasoning_context: eReasoningContextSchema.optional().nullable(),
  /* OpenAI: Verbosity control */
  verbosity: eVerbositySchema.optional().nullable(),
  /* OpenAI: use Responses API */
  useResponsesApi: z.boolean().optional(),
  /* Anthropic: Effort control */
  effort: eAnthropicEffortSchema.optional().nullable(),
  /* Anthropic: Thinking visibility (Opus 4.7+ opt-in) */
  thinkingDisplay: eThinkingDisplaySchema.optional().nullable(),
  /* OpenAI Responses API / Anthropic API / Google API */
  web_search: z.boolean().optional(),
  /* Google API: URL Context tool (+ native YouTube video understanding) */
  url_context: z.boolean().optional(),
  /* disable streaming */
  disableStreaming: z.boolean().optional(),
  /* assistant */
  assistant_id: z.string().optional(),
  /* agents */
  agent_id: z.string().optional(),
  /* AWS Bedrock */
  region: z.string().optional(),
  maxTokens: coerceNumber.optional(),
  additionalModelRequestFields: DocumentType.optional(),
  /* assistants */
  instructions: z.string().optional(),
  additional_instructions: z.string().optional(),
  append_current_datetime: z.boolean().optional(),
  /** Used to overwrite active conversation settings when saving a Preset */
  presetOverride: z.record(z.unknown()).optional(),
  stop: z.array(z.string()).optional(),
  /* Ollama */
  top_k: z.number().optional(),
  num_ctx: coerceNumber.optional(),
  num_predict: coerceNumber.optional(),
  repeat_penalty: z.number().optional(),
  repeat_last_n: coerceNumber.optional(),
  mirostat: coerceNumber.optional(),
  mirostat_eta: z.number().optional(),
  mirostat_tau: z.number().optional(),
  tfs_z: z.number().optional(),
  seed: coerceNumber.nullable().optional(),
  /* frontend components */
  greeting: z.string().optional(),
  spec: z.string().nullable().optional(),
  iconURL: z.string().nullable().optional(),
  /* temporary chat */
  expiredAt: z.string().nullable().optional(),
  isTemporary: z.boolean().optional(),
  /* file token limits */
  fileTokenLimit: coerceNumber.optional(),
  /** @deprecated */
  resendImages: z.boolean().optional(),
  /** @deprecated Prefer `modelLabel` over `chatGptLabel` */
  chatGptLabel: z.string().nullable().optional(),
});

export const tPresetSchema = tConversationSchema
  .omit({
    conversationId: true,
    chatProjectId: true,
    createdAt: true,
    updatedAt: true,
    title: true,
  })
  .merge(
    z.object({
      conversationId: z.string().nullable().optional(),
      presetId: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      defaultPreset: z.boolean().optional(),
      order: z.number().optional(),
      endpoint: extendedModelEndpointSchema.nullable(),
    }),
  );

export const tConvoUpdateSchema = tConversationSchema.merge(
  z.object({
    endpoint: extendedModelEndpointSchema.nullable(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
);

export const tQueryParamsSchema = tConversationSchema
  .pick({
    // librechat settings
    /** The model spec to be used */
    spec: true,
    /** The AI context window, overrides the system-defined window as determined by `model` value */
    maxContextTokens: true,
    /**
     * Whether or not to re-submit files from previous messages on subsequent messages
     * */
    resendFiles: true,
    /**
     * @endpoints openAI, custom, azureOpenAI
     *
     * System parameter that only affects the above endpoints.
     * Image detail for re-sizing according to OpenAI spec, defaults to `auto`
     * */
    imageDetail: true,
    /**
     * AKA Custom Instructions, dynamically added to chat history as a system message;
     * for `bedrock` endpoint, this is used as the `system` model param if the provider uses it;
     * for `assistants` endpoint, this is used as the `additional_instructions` model param:
     * https://platform.openai.com/docs/api-reference/runs/createRun#runs-createrun-additional_instructions
     * ; otherwise, a message with `system` role is added to the chat history
     */
    promptPrefix: true,
    // Model parameters
    /** @endpoints openAI, custom, azureOpenAI, google, anthropic, assistants, azureAssistants, bedrock */
    model: true,
    /** @endpoints openAI, custom, azureOpenAI, google, anthropic, bedrock */
    temperature: true,
    /** @endpoints openAI, custom, azureOpenAI */
    presence_penalty: true,
    /** @endpoints openAI, custom, azureOpenAI */
    frequency_penalty: true,
    /** @endpoints openAI, custom, azureOpenAI */
    stop: true,
    /** @endpoints openAI, custom, azureOpenAI */
    top_p: true,
    /** @endpoints openAI, custom, azureOpenAI */
    max_tokens: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_effort: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_summary: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_mode: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_context: true,
    /** @endpoints openAI, custom, azureOpenAI */
    verbosity: true,
    /** @endpoints openAI, custom, azureOpenAI */
    useResponsesApi: true,
    /** @endpoints openAI, anthropic, google */
    web_search: true,
    /** @endpoints google */
    url_context: true,
    /** @endpoints openAI, custom, azureOpenAI */
    disableStreaming: true,
    /** @endpoints google, anthropic, bedrock */
    topP: true,
    /** @endpoints google, anthropic */
    topK: true,
    /** @endpoints google, anthropic */
    maxOutputTokens: true,
    /** @endpoints anthropic */
    promptCache: true,
    promptCacheTtl: true,
    thinking: true,
    thinkingBudget: true,
    thinkingLevel: true,
    effort: true,
    thinkingDisplay: true,
    /** @endpoints bedrock */
    region: true,
    /** @endpoints bedrock */
    maxTokens: true,
    /** @endpoints agents */
    agent_id: true,
    /** @endpoints assistants, azureAssistants */
    assistant_id: true,
    /** @endpoints assistants, azureAssistants */
    append_current_datetime: true,
    /**
     * @endpoints assistants, azureAssistants
     *
     * Overrides existing assistant instructions, only used for the current run:
     * https://platform.openai.com/docs/api-reference/runs/createRun#runs-createrun-instructions
     * */
    instructions: true,
    /** @endpoints openAI, google, anthropic */
    fileTokenLimit: true,
  })
  .merge(
    z.object({
      /** @endpoints openAI, custom, azureOpenAI, google, anthropic, assistants, azureAssistants, bedrock, agents */
      endpoint: extendedModelEndpointSchema.nullable(),
    }),
  );

/** Narrowed preset schema for use in model specs — omits system/DB/deprecated fields.
 *
 * `greeting` and `iconURL` are admin-configurable display fields on a model spec's
 * preset (landing greeting, preset-level icon fallback) and must be preserved.
 * `spec` is set by the client from `modelSpec.name` via `getModelSpecPreset` and is
 * omitted to avoid duplicate configuration surface.
 */
export const tModelSpecPresetSchema = tPresetSchema.omit({
  conversationId: true,
  presetId: true,
  title: true,
  defaultPreset: true,
  order: true,
  isArchived: true,
  user: true,
  messages: true,
  tags: true,
  file_ids: true,
  expiredAt: true,
  parentMessageId: true,
  resendImages: true,
  chatGptLabel: true,
  presetOverride: true,
  spec: true,
});

export type TModelSpecPreset = z.infer<typeof tModelSpecPresetSchema>;

export type TPreset = z.infer<typeof tPresetSchema>;

export type TSetOption = (
  param: number | string,
) => (newValue: number | string | boolean | string[] | Partial<TPreset>) => void;

export type TConversation = z.infer<typeof tConversationSchema> & {
  presetOverride?: Partial<TPreset>;
  disableParams?: boolean;
};

export const tSharedLinkSchema = z.object({
  conversationId: z.string(),
  shareId: z.string(),
  targetMessageId: z.string().optional(),
  messages: z.array(z.string()),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TSharedLink = z.infer<typeof tSharedLinkSchema>;

export const tConversationTagSchema = z.object({
  _id: z.string(),
  user: z.string(),
  tag: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  count: z.number(),
  position: z.number(),
});
export type TConversationTag = z.infer<typeof tConversationTagSchema>;

export function removeNullishValues<T extends Record<string, unknown>>(
  obj: T,
  removeEmptyStrings?: boolean,
): Partial<T> {
  const newObj: Partial<T> = { ...obj };

  (Object.keys(newObj) as Array<keyof T>).forEach((key) => {
    const value = newObj[key];
    if (value === undefined || value === null) {
      delete newObj[key];
    }
    if (removeEmptyStrings && typeof value === 'string' && value === '') {
      delete newObj[key];
    }
  });

  return newObj;
}

export const agentsBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  modelLabel: true,
  temperature: true,
  top_p: true,
  presence_penalty: true,
  frequency_penalty: true,
  resendFiles: true,
  imageDetail: true,
  agent_id: true,
  instructions: true,
  promptPrefix: true,
  iconURL: true,
  greeting: true,
  maxContextTokens: true,
});

export const agentsSchema = agentsBaseSchema
  .transform((obj) => ({
    ...obj,
    model: obj.model ?? agentsSettings.model.default,
    modelLabel: obj.modelLabel ?? null,
    temperature: obj.temperature ?? 1,
    top_p: obj.top_p ?? 1,
    presence_penalty: obj.presence_penalty ?? 0,
    frequency_penalty: obj.frequency_penalty ?? 0,
    resendFiles:
      typeof obj.resendFiles === 'boolean' ? obj.resendFiles : agentsSettings.resendFiles.default,
    imageDetail: obj.imageDetail ?? ImageDetail.auto,
    agent_id: obj.agent_id ?? undefined,
    instructions: obj.instructions ?? undefined,
    promptPrefix: obj.promptPrefix ?? null,
    iconURL: obj.iconURL ?? undefined,
    greeting: obj.greeting ?? undefined,
    maxContextTokens: obj.maxContextTokens ?? undefined,
  }))
  .catch(() => ({
    model: agentsSettings.model.default,
    modelLabel: null,
    temperature: 1,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    resendFiles: agentsSettings.resendFiles.default,
    imageDetail: ImageDetail.auto,
    agent_id: undefined,
    instructions: undefined,
    promptPrefix: null,
    iconURL: undefined,
    greeting: undefined,
    maxContextTokens: undefined,
  }));

export const customBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  modelLabel: true,
  promptPrefix: true,
  temperature: true,
  top_p: true,
  top_k: true,
  presence_penalty: true,
  frequency_penalty: true,
  num_ctx: true,
  num_predict: true,
  repeat_penalty: true,
  repeat_last_n: true,
  mirostat: true,
  mirostat_eta: true,
  mirostat_tau: true,
  tfs_z: true,
  seed: true,
  resendFiles: true,
  artifacts: true,
  imageDetail: true,
  stop: true,
  iconURL: true,
  greeting: true,
  spec: true,
  maxContextTokens: true,
  max_tokens: true,
  disableStreaming: true,
  fileTokenLimit: true,
  /**
   * OpenAI-Harmony-style reasoning/response fields — still processed by
   * `getOpenAILLMConfig` regardless of endpoint, so reasoning-capable
   * self-hosted or proxied models served through a custom endpoint (e.g.
   * gpt-oss, DeepSeek-R1 via Ollama or a LiteLLM gateway) can use them.
   */
  reasoning_effort: true,
  reasoning_summary: true,
  reasoning_mode: true,
  reasoning_context: true,
  verbosity: true,
  useResponsesApi: true,
  web_search: true,
});

export const customSchema = customBaseSchema
  .transform((obj: Partial<TConversation>) => removeNullishValues(obj, true))
  .catch(() => ({}));

export const tBannerSchema = z.object({
  bannerId: z.string(),
  message: z.string(),
  displayFrom: z.string(),
  displayTo: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isPublic: z.boolean(),
  persistable: z.boolean().default(false),
});
export type TBanner = z.infer<typeof tBannerSchema>;

export const compactAgentsBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  spec: true,
  // model: true,
  iconURL: true,
  greeting: true,
  agent_id: true,
  instructions: true,
  additional_instructions: true,
});

export const compactAgentsSchema = compactAgentsBaseSchema
  .transform((obj) => removeNullishValues(obj))
  .catch(() => ({}));
