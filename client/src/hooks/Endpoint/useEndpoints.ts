import React, { useMemo, useCallback } from 'react';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  Permissions,
  alternateName,
  EModelEndpoint,
  PermissionTypes,
  getEndpointField,
  getConfigDefaults,
} from 'librechat-data-provider';
import type { TEndpointsConfig, TStartupConfig, Agent } from 'librechat-data-provider';
import type { Endpoint } from '~/common';
import { useHasAccess, useShowMarketplace } from '~/hooks';
import { useGetEndpointsQuery } from '~/data-provider';
import { mapEndpoints, getIconKey } from '~/utils';
import { icons } from './Icons';

const defaultInterface = getConfigDefaults().interface;

export const useEndpoints = ({
  agents,
  endpointsConfig,
  startupConfig,
}: {
  agents?: Agent[] | null;
  endpointsConfig: TEndpointsConfig;
  startupConfig: TStartupConfig | undefined;
}) => {
  const modelsQuery = useGetModelsQuery();
  const { data: endpoints = [] } = useGetEndpointsQuery({ select: mapEndpoints });
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  const includedEndpoints = useMemo(
    () => new Set(startupConfig?.modelSpecs?.addedEndpoints ?? []),
    [startupConfig?.modelSpecs?.addedEndpoints],
  );

  const hasAgentAccess = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const showAgentMarketplace = useShowMarketplace();

  const filteredEndpoints = useMemo(() => {
    if (!interfaceConfig.modelSelect) {
      return [];
    }
    const result: EModelEndpoint[] = [];
    for (let i = 0; i < endpoints.length; i++) {
      if (endpoints[i] === EModelEndpoint.agents && !hasAgentAccess) {
        continue;
      }
      if (includedEndpoints.size > 0 && !includedEndpoints.has(endpoints[i])) {
        continue;
      }
      result.push(endpoints[i]);
    }

    return result;
  }, [endpoints, hasAgentAccess, includedEndpoints, interfaceConfig.modelSelect]);

  const endpointRequiresUserKey = useCallback(
    (ep: string) => {
      return !!getEndpointField(endpointsConfig, ep, 'userProvide');
    },
    [endpointsConfig],
  );

  const mappedEndpoints: Endpoint[] = useMemo(() => {
    return filteredEndpoints.reduce<Endpoint[]>((acc, ep) => {
      const endpointType = getEndpointField(endpointsConfig, ep, 'type');
      const iconKey = getIconKey({ endpoint: ep, endpointsConfig, endpointType });
      const Icon = icons[iconKey];
      const endpointIconURL = getEndpointField(endpointsConfig, ep, 'iconURL');
      const hasModels =
        (ep === EModelEndpoint.agents && ((agents?.length ?? 0) > 0 || showAgentMarketplace)) ||
        (ep !== EModelEndpoint.agents && (modelsQuery.data?.[ep]?.length ?? 0) > 0);

      if (ep === EModelEndpoint.agents && !hasModels) {
        return acc;
      }

      // Base result object with formatted default icon
      const result: Endpoint = {
        value: ep,
        label: alternateName[ep] || ep,
        hasModels,
        icon: Icon
          ? React.createElement(Icon, {
              size: 20,
              className: 'text-text-primary shrink-0 icon-md',
              iconURL: endpointIconURL,
              endpoint: ep,
            })
          : null,
      };

      if (ep === EModelEndpoint.agents && showAgentMarketplace) {
        result.showMarketplace = true;
        result.searchAliases = ['agent marketplace', 'marketplace'];
      }

      // Handle agents case
      if (ep === EModelEndpoint.agents && (agents?.length ?? 0) > 0) {
        result.models = agents?.map((agent) => ({
          name: agent.id,
          isGlobal: agent.isPublic ?? false,
        }));
        result.agentNames = agents?.reduce((acc, agent) => {
          acc[agent.id] = agent.name || '';
          return acc;
        }, {});
        result.modelIcons = agents?.reduce((acc, agent) => {
          acc[agent.id] = agent?.avatar?.filepath;
          return acc;
        }, {});
      }

      // For other endpoints with models from the modelsQuery
      else if (ep !== EModelEndpoint.agents && (modelsQuery.data?.[ep]?.length ?? 0) > 0) {
        result.models = modelsQuery.data?.[ep]?.map((model) => ({
          name: model,
          isGlobal: false,
        }));
      }

      acc.push(result);
      return acc;
    }, []);
  }, [agents, endpointsConfig, filteredEndpoints, modelsQuery.data, showAgentMarketplace]);

  return {
    mappedEndpoints,
    endpointRequiresUserKey,
  };
};

export default useEndpoints;
