import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, removeNullishValues, normalizeEndpointName } from 'librechat-data-provider';
import type { TCustomConfig, TEndpoint, TTransactionsConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { isEnabled } from '~/utils';

/**
 * Retrieves the balance configuration object
 * */
export function getBalanceConfig(appConfig?: AppConfig): Partial<TCustomConfig['balance']> | null {
  const isLegacyEnabled = isEnabled(process.env.CHECK_BALANCE);
  const startBalance = process.env.START_BALANCE;
  /** @type {} */
  const config: Partial<TCustomConfig['balance']> = removeNullishValues({
    enabled: isLegacyEnabled,
    startBalance: startBalance != null && startBalance ? parseInt(startBalance, 10) : undefined,
  });
  if (!appConfig) {
    return config;
  }
  return { ...config, ...(appConfig?.['balance'] ?? {}) };
}

/**
 * Retrieves the transactions configuration object
 * */
export function getTransactionsConfig(appConfig?: AppConfig): Partial<TTransactionsConfig> {
  const defaultConfig: TTransactionsConfig = { enabled: true };

  if (!appConfig) {
    return defaultConfig;
  }

  const transactionsConfig = appConfig?.['transactions'] ?? defaultConfig;
  const balanceConfig = getBalanceConfig(appConfig);

  // If balance is enabled but transactions are disabled, force transactions to be enabled
  // and log a warning
  if (balanceConfig?.enabled && !transactionsConfig.enabled) {
    logger.warn(
      'Configuration warning: transactions.enabled=false is incompatible with balance.enabled=true. ' +
        'Transactions will be enabled to ensure balance tracking works correctly.',
    );
    return { ...transactionsConfig, enabled: true };
  }

  return transactionsConfig;
}

export const getCustomEndpointConfig = ({
  endpoint,
  appConfig,
}: {
  endpoint: string | EModelEndpoint;
  appConfig?: AppConfig;
}): Partial<TEndpoint> | undefined => {
  if (!appConfig) {
    throw new Error(`Config not found for the ${endpoint} custom endpoint.`);
  }

  const customEndpoints = appConfig.endpoints?.[EModelEndpoint.custom] ?? [];

  /**
   * Exact-case match always wins first — this is how a user can run e.g.
   * `"Ollama"` and `"ollama"` as two distinct, individually-addressable
   * entries (`loadCustomEndpointsConfig`'s keys are case-preserving).
   */
  const exactMatch = customEndpoints.find((endpointConfig) => endpointConfig.name === endpoint);
  if (exactMatch) {
    return exactMatch;
  }

  /**
   * No exact match: fold the one narrow exception, Ollama. Every layer that
   * surfaces a custom endpoint's identity to the frontend or persists it
   * (`loadCustomEndpointsConfig`, `loadConfigModels`) already folds a
   * case-insensitive "ollama" match to lowercase via `normalizeEndpointName` —
   * that's the identifier that ends up in `endpointsConfig`, `modelsConfig`,
   * and persisted `conversation.endpoint`/`agent_id` values, regardless of
   * how the admin capitalized `name` in librechat.yaml (commonly `"Ollama"`,
   * to get the built-in icon — icon-matching is itself case-insensitive now,
   * see `UnknownIcon`, so that capitalization is purely cosmetic). Applying
   * the same fold here keeps this lookup in sync with that identifier at the
   * single source every caller goes through, instead of requiring each of
   * the half-dozen call sites to re-resolve via `getProviderConfig` first.
   * Other custom endpoints keep requiring an exact-case match — only the
   * literal word "ollama" folds, and only when no exact match already won.
   *
   * That fold can turn a would-be exact match into an ambiguous one (e.g. an
   * admin who configures both `"Ollama"` and `"OLLAMA"` as distinct entries,
   * neither of which is the literal lowercase `"ollama"`), so resolve via a
   * filter + explicit ambiguity check rather than `.find`, which would
   * silently return whichever entry happens to be array-first.
   */
  if (normalizeEndpointName(endpoint) !== 'ollama') {
    return undefined;
  }

  const matches = customEndpoints.filter(
    (endpointConfig) => normalizeEndpointName(endpointConfig.name) === 'ollama',
  );

  if (matches.length > 1) {
    const names = matches.map((match) => match.name ?? '').join(', ');
    throw new Error(
      `Provider ${endpoint} is ambiguous: multiple custom endpoints match case-insensitively (${names}). Rename one or use the exact-case provider value.`,
    );
  }

  return matches[0];
};
