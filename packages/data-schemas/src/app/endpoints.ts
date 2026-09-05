import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpoint, TCustomConfig, TAgentsEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '~/types';
import { agentsConfigSetup } from './agents';

/**
 * Loads custom config endpoints
 * @param [config]
 * @param [agentsDefaults]
 */
export const loadEndpoints = (
  config: Partial<TCustomConfig>,
  agentsDefaults?: Partial<TAgentsEndpoint>,
): {
  allowedAddresses?: string[];
  all?: Partial<TEndpoint>;
  agents?: Partial<TAgentsEndpoint>;
  custom?: import('librechat-data-provider').TCustomEndpoints;
} => {
  const loadedEndpoints: AppConfig['endpoints'] = {};
  const endpoints = config?.endpoints;

  loadedEndpoints[EModelEndpoint.agents] = agentsConfigSetup(config, agentsDefaults);

  if (endpoints?.[EModelEndpoint.custom]) {
    /**
     * `DeepPartial<TCustomConfig>` widens record values to `string | undefined`
     * (e.g. `headers`), so cast to the concrete endpoint type — mirrors the
     * `endpoints.all as Partial<TEndpoint>` cast below.
     */
    loadedEndpoints[EModelEndpoint.custom] = endpoints[
      EModelEndpoint.custom
    ] as import('librechat-data-provider').TCustomEndpoints;
  }

  if (endpoints?.all) {
    /**
     * `DeepPartial<TCustomConfig>` widens record values to `string | undefined`
     * (e.g. `headers`), so cast to the concrete endpoint type — mirrors the
     * `endpoints[EModelEndpoint.custom] as TCustomEndpoints` cast above.
     */
    loadedEndpoints.all = endpoints.all as Partial<TEndpoint>;
  }

  if (endpoints?.allowedAddresses) {
    loadedEndpoints.allowedAddresses = endpoints.allowedAddresses;
  }

  return loadedEndpoints;
};
