import { ImageDetail, EModelEndpoint, ollamaSettings } from './types';
import { SettingDefinition, SettingsConfiguration } from './generate';
import { Providers, ReasoningEffort } from './schemas';

// Base definitions
const baseDefinitions: Record<string, SettingDefinition> = {
  model: {
    key: 'model',
    label: 'com_ui_model',
    labelCode: true,
    type: 'string',
    component: 'dropdown',
    optionType: 'model',
    selectPlaceholder: 'com_ui_select_model',
    searchPlaceholder: 'com_ui_select_search_model',
    searchPlaceholderCode: true,
    selectPlaceholderCode: true,
    columnSpan: 4,
  },
  temperature: {
    key: 'temperature',
    label: 'com_endpoint_temperature',
    labelCode: true,
    description: 'com_endpoint_openai_temp',
    descriptionCode: true,
    type: 'number',
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  topP: {
    key: 'topP',
    label: 'com_endpoint_top_p',
    labelCode: true,
    description: 'com_endpoint_anthropic_topp',
    descriptionCode: true,
    type: 'number',
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  stop: {
    key: 'stop',
    label: 'com_endpoint_stop',
    labelCode: true,
    description: 'com_endpoint_openai_stop',
    descriptionCode: true,
    placeholder: 'com_endpoint_stop_placeholder',
    placeholderCode: true,
    type: 'array',
    default: [],
    component: 'tags',
    optionType: 'conversation',
    minTags: 0,
    maxTags: 4,
  },
  imageDetail: {
    key: 'imageDetail',
    label: 'com_endpoint_plug_image_detail',
    labelCode: true,
    description: 'com_endpoint_openai_detail',
    descriptionCode: true,
    type: 'enum',
    default: ImageDetail.auto,
    component: 'slider',
    options: [ImageDetail.low, ImageDetail.auto, ImageDetail.high],
    enumMappings: {
      [ImageDetail.low]: 'com_ui_low',
      [ImageDetail.auto]: 'com_ui_auto',
      [ImageDetail.high]: 'com_ui_high',
    },
    optionType: 'conversation',
    columnSpan: 2,
  },
};

const createDefinition = (
  base: Partial<SettingDefinition>,
  overrides: Partial<SettingDefinition>,
): SettingDefinition => {
  return { ...base, ...overrides } as SettingDefinition;
};

export const librechat = {
  modelLabel: {
    key: 'modelLabel',
    label: 'com_endpoint_custom_name',
    labelCode: true,
    type: 'string',
    default: '',
    component: 'input',
    placeholder: 'com_endpoint_openai_custom_name_placeholder',
    placeholderCode: true,
    optionType: 'conversation',
  } as const,
  maxContextTokens: {
    key: 'maxContextTokens',
    label: 'com_endpoint_context_tokens',
    labelCode: true,
    type: 'number',
    component: 'input',
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    description: 'com_endpoint_context_info',
    descriptionCode: true,
    optionType: 'model',
    columnSpan: 2,
  } as const,
  resendFiles: {
    key: 'resendFiles',
    label: 'com_endpoint_plug_resend_files',
    labelCode: true,
    description: 'com_endpoint_openai_resend_files',
    descriptionCode: true,
    type: 'boolean',
    default: true,
    component: 'switch',
    optionType: 'conversation',
    showDefault: false,
    columnSpan: 2,
  } as const,
  promptPrefix: {
    key: 'promptPrefix',
    label: 'com_endpoint_prompt_prefix',
    labelCode: true,
    type: 'string',
    default: '',
    component: 'textarea',
    placeholder: 'com_endpoint_openai_prompt_prefix_placeholder',
    placeholderCode: true,
    optionType: 'model',
  } as const,
  fileTokenLimit: {
    key: 'fileTokenLimit',
    label: 'com_ui_file_token_limit',
    labelCode: true,
    description: 'com_ui_file_token_limit_desc',
    descriptionCode: true,
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    type: 'number',
    component: 'input',
    columnSpan: 2,
  } as const,
};

const ollamaParams: Record<string, SettingDefinition> = {
  promptPrefix: librechat.promptPrefix,
  temperature: createDefinition(baseDefinitions.temperature, {
    default: ollamaSettings.temperature.default,
    range: {
      min: ollamaSettings.temperature.min,
      max: ollamaSettings.temperature.max,
      step: ollamaSettings.temperature.step,
    },
  }),
  top_p: createDefinition(baseDefinitions.topP, {
    key: 'top_p',
    default: ollamaSettings.top_p.default,
    range: {
      min: ollamaSettings.top_p.min,
      max: ollamaSettings.top_p.max,
      step: ollamaSettings.top_p.step,
    },
  }),
  top_k: {
    key: 'top_k',
    label: 'com_endpoint_top_k',
    labelCode: true,
    description: 'com_endpoint_ollama_top_k',
    descriptionCode: true,
    type: 'number',
    default: ollamaSettings.top_k.default,
    range: {
      min: ollamaSettings.top_k.min,
      max: ollamaSettings.top_k.max,
      step: ollamaSettings.top_k.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  num_ctx: {
    key: 'num_ctx',
    label: 'com_endpoint_ollama_num_ctx',
    labelCode: true,
    description: 'com_endpoint_ollama_num_ctx_description',
    descriptionCode: true,
    type: 'number',
    component: 'input',
    default: ollamaSettings.num_ctx.default,
    range: {
      min: ollamaSettings.num_ctx.min,
      max: ollamaSettings.num_ctx.max,
      step: ollamaSettings.num_ctx.step,
    },
    optionType: 'model',
    columnSpan: 2,
  },
  num_predict: {
    key: 'num_predict',
    label: 'com_endpoint_ollama_num_predict',
    labelCode: true,
    description: 'com_endpoint_ollama_num_predict_description',
    descriptionCode: true,
    type: 'number',
    component: 'input',
    default: ollamaSettings.num_predict.default,
    range: {
      min: ollamaSettings.num_predict.min,
      max: ollamaSettings.num_predict.max,
      step: ollamaSettings.num_predict.step,
    },
    optionType: 'model',
    columnSpan: 2,
  },
  repeat_penalty: {
    key: 'repeat_penalty',
    label: 'com_endpoint_ollama_repeat_penalty',
    labelCode: true,
    description: 'com_endpoint_ollama_repeat_penalty_description',
    descriptionCode: true,
    type: 'number',
    default: ollamaSettings.repeat_penalty.default,
    range: {
      min: ollamaSettings.repeat_penalty.min,
      max: ollamaSettings.repeat_penalty.max,
      step: ollamaSettings.repeat_penalty.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  repeat_last_n: {
    key: 'repeat_last_n',
    label: 'com_endpoint_ollama_repeat_last_n',
    labelCode: true,
    description: 'com_endpoint_ollama_repeat_last_n_description',
    descriptionCode: true,
    type: 'number',
    component: 'input',
    default: ollamaSettings.repeat_last_n.default,
    range: {
      min: ollamaSettings.repeat_last_n.min,
      max: ollamaSettings.repeat_last_n.max,
      step: ollamaSettings.repeat_last_n.step,
    },
    optionType: 'model',
    columnSpan: 2,
  },
  mirostat: {
    key: 'mirostat',
    label: 'com_endpoint_ollama_mirostat',
    labelCode: true,
    description: 'com_endpoint_ollama_mirostat_description',
    descriptionCode: true,
    type: 'number',
    default: ollamaSettings.mirostat.default,
    range: {
      min: ollamaSettings.mirostat.min,
      max: ollamaSettings.mirostat.max,
      step: ollamaSettings.mirostat.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  mirostat_eta: {
    key: 'mirostat_eta',
    label: 'com_endpoint_ollama_mirostat_eta',
    labelCode: true,
    description: 'com_endpoint_ollama_mirostat_eta_description',
    descriptionCode: true,
    type: 'number',
    default: ollamaSettings.mirostat_eta.default,
    range: {
      min: ollamaSettings.mirostat_eta.min,
      max: ollamaSettings.mirostat_eta.max,
      step: ollamaSettings.mirostat_eta.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  mirostat_tau: {
    key: 'mirostat_tau',
    label: 'com_endpoint_ollama_mirostat_tau',
    labelCode: true,
    description: 'com_endpoint_ollama_mirostat_tau_description',
    descriptionCode: true,
    type: 'number',
    default: ollamaSettings.mirostat_tau.default,
    range: {
      min: ollamaSettings.mirostat_tau.min,
      max: ollamaSettings.mirostat_tau.max,
      step: ollamaSettings.mirostat_tau.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  tfs_z: {
    key: 'tfs_z',
    label: 'com_endpoint_ollama_tfs_z',
    labelCode: true,
    description: 'com_endpoint_ollama_tfs_z_description',
    descriptionCode: true,
    type: 'number',
    default: ollamaSettings.tfs_z.default,
    range: {
      min: ollamaSettings.tfs_z.min,
      max: ollamaSettings.tfs_z.max,
      step: ollamaSettings.tfs_z.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  seed: {
    key: 'seed',
    label: 'com_endpoint_ollama_seed',
    labelCode: true,
    description: 'com_endpoint_ollama_seed_description',
    descriptionCode: true,
    type: 'number',
    component: 'input',
    placeholder: 'com_endpoint_ollama_seed_placeholder',
    placeholderCode: true,
    optionType: 'model',
    columnSpan: 2,
  },
  /**
   * Ollama's OpenAI-compatible `/v1/chat/completions` endpoint accepts a
   * top-level `reasoning_effort` field for thinking-capable models (Qwen3,
   * gpt-oss, deepseek-r1, etc.) with exactly these five values — no
   * `minimal`/`xhigh` (those exist on `ReasoningEffort` for other providers,
   * not Ollama). Left unset, Ollama auto-enables thinking for capable models.
   * `getOpenAILLMConfig` already forwards this to `modelKwargs.reasoning_effort`
   * for any custom endpoint; this definition just exposes the control in the UI.
   */
  reasoning_effort: {
    key: 'reasoning_effort',
    label: 'com_endpoint_ollama_reasoning_effort',
    labelCode: true,
    description: 'com_endpoint_ollama_reasoning_effort_description',
    descriptionCode: true,
    type: 'enum',
    default: ReasoningEffort.unset,
    options: [
      ReasoningEffort.unset,
      ReasoningEffort.none,
      ReasoningEffort.low,
      ReasoningEffort.medium,
      ReasoningEffort.high,
      ReasoningEffort.max,
    ],
    enumMappings: {
      [ReasoningEffort.unset]: 'com_ui_auto',
      [ReasoningEffort.none]: 'com_ui_none',
      [ReasoningEffort.low]: 'com_ui_low',
      [ReasoningEffort.medium]: 'com_ui_medium',
      [ReasoningEffort.high]: 'com_ui_high',
      [ReasoningEffort.max]: 'com_ui_max',
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  disableStreaming: {
    key: 'disableStreaming',
    label: 'com_endpoint_disable_streaming_label',
    labelCode: true,
    description: 'com_endpoint_disable_streaming',
    descriptionCode: true,
    type: 'boolean',
    default: false,
    component: 'switch',
    optionType: 'model',
    showDefault: false,
    columnSpan: 2,
  },
};

const ollamaCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const ollamaCol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  ollamaParams.temperature,
  ollamaParams.top_p,
  ollamaParams.top_k,
  ollamaParams.reasoning_effort,
  ollamaParams.num_ctx,
  ollamaParams.num_predict,
  ollamaParams.repeat_penalty,
  ollamaParams.repeat_last_n,
  ollamaParams.mirostat,
  ollamaParams.mirostat_eta,
  ollamaParams.mirostat_tau,
  ollamaParams.tfs_z,
  ollamaParams.seed,
  baseDefinitions.stop,
  librechat.resendFiles,
  ollamaParams.disableStreaming,
  librechat.fileTokenLimit,
];

const ollamaConfig: SettingsConfiguration = [...ollamaCol1, ...ollamaCol2];

/** OpenRouter proxies many models that support prompt caching; the toggle is
 *  surfaced here (not a native provider) because `loadCustomConfig.js`'s
 *  `addOpenRouterDefaults` auto-injects this param definition for any custom
 *  endpoint named/urled like OpenRouter. */
const promptCache: SettingDefinition = {
  key: 'promptCache',
  label: 'com_endpoint_prompt_cache',
  labelCode: true,
  description: 'com_endpoint_anthropic_prompt_cache',
  descriptionCode: true,
  type: 'boolean',
  default: true,
  component: 'switch',
  optionType: 'conversation',
  showDefault: false,
  columnSpan: 2,
};

const openRouterCol2: SettingsConfiguration = [...ollamaCol2, promptCache];
const openRouterConfig: SettingsConfiguration = [...ollamaCol1, ...openRouterCol2];

export const paramSettings: Record<string, SettingsConfiguration | undefined> = {
  [EModelEndpoint.custom]: ollamaConfig,
  [Providers.OPENROUTER]: openRouterConfig,
};

const ollamaColumns = {
  col1: ollamaCol1,
  col2: ollamaCol2,
};

export const presetSettings: Record<
  string,
  | {
      col1: SettingsConfiguration;
      col2: SettingsConfiguration;
    }
  | undefined
> = {
  [EModelEndpoint.custom]: ollamaColumns,
  [Providers.OPENROUTER]: {
    col1: ollamaCol1,
    col2: openRouterCol2,
  },
};

export const agentParamSettings: Record<string, SettingsConfiguration | undefined> = Object.entries(
  presetSettings,
).reduce<Record<string, SettingsConfiguration | undefined>>((acc, [key, value]) => {
  if (value) {
    acc[key] = value.col2;
  }
  return acc;
}, {});

/**
 * Resolves model-aware defaults for a settings configuration before rendering.
 * No remaining endpoint needs model-aware defaults (that was Google-specific,
 * removed with the other non-Ollama providers) — kept as a passthrough so
 * callers don't need to special-case its absence.
 */
export function applyModelAwareDefaults(
  settings: SettingsConfiguration,
  _endpoint: string,
  _model?: string,
): SettingsConfiguration {
  return settings;
}
