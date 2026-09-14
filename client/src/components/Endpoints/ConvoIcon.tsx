import React, { useMemo } from 'react';
import { getEndpointField } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import { getIconKey, getEntity, getIconEndpoint } from '~/utils';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import { icons } from '~/hooks/Endpoint/Icons';
import { isImageURL } from '~/utils/icons';

export default function ConvoIcon({
  conversation,
  endpointsConfig,
  agentsMap,
  className = '',
  containerClassName = '',
  context,
  size,
}: {
  conversation: t.TConversation | t.TPreset | null;
  endpointsConfig: t.TEndpointsConfig;
  agentsMap: t.TAgentsMap | undefined;
  containerClassName?: string;
  context?: 'message' | 'nav' | 'landing' | 'menu-item';
  className?: string;
  size?: number;
}) {
  const iconURL = conversation?.iconURL ?? '';
  let endpoint = conversation?.endpoint;
  endpoint = getIconEndpoint({ endpointsConfig, iconURL, endpoint });

  const { entity, isAgent } = useMemo(
    () =>
      getEntity({
        endpoint,
        agentsMap,
        agent_id: conversation?.agent_id,
      }),
    [endpoint, conversation?.agent_id, agentsMap],
  );

  const name = entity?.name ?? '';
  const avatar = isAgent ? (entity as t.Agent | undefined)?.avatar?.filepath : undefined;

  const endpointIconURL = getEndpointField(endpointsConfig, endpoint, 'iconURL');
  const iconKey = getIconKey({ endpoint, endpointsConfig, endpointIconURL });
  const Icon = icons[iconKey] ?? null;

  return (
    <>
      {isImageURL(iconURL) ? (
        <ConvoIconURL
          iconURL={iconURL}
          modelLabel={conversation?.chatGptLabel ?? conversation?.modelLabel ?? ''}
          endpointIconURL={endpointIconURL}
          agentAvatar={avatar}
          agentName={name}
          context={context}
        />
      ) : (
        <div className={containerClassName}>
          {endpoint && Icon != null && (
            <Icon
              size={size}
              context={context}
              endpoint={endpoint}
              className={className}
              iconURL={endpointIconURL}
              agentName={name}
              avatar={avatar}
            />
          )}
        </div>
      )}
    </>
  );
}
