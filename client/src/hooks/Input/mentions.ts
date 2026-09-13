import { EModelEndpoint, isAgentsEndpoint } from 'librechat-data-provider';

export function filterMentionEndpoints({
  endpoints,
  includedEndpoints,
  hasAgentAccess,
}: {
  endpoints: Array<EModelEndpoint | string>;
  includedEndpoints: Set<string>;
  hasAgentAccess: boolean;
}) {
  const hasEndpointAllowList = includedEndpoints.size > 0;

  return endpoints.filter((endpoint) => {
    if (isAgentsEndpoint(endpoint) && !hasAgentAccess) {
      return false;
    }

    if (hasEndpointAllowList && !includedEndpoints.has(endpoint)) {
      return false;
    }

    return true;
  });
}
