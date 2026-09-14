import { getEndpointField, isAgentsEndpoint } from 'librechat-data-provider';
import type { TPreset, TConversation, TAgentsMap, TEndpointsConfig } from 'librechat-data-provider';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import MinimalIcon from '~/components/Endpoints/MinimalIcon';
import { getAgentAvatarUrl, getIconEndpoint } from '~/utils';
import { isImageURL } from '~/utils/icons';

const emptyEndpointsConfig = {} as TEndpointsConfig;

export default function EndpointIcon({
  conversation,
  endpointsConfig = emptyEndpointsConfig,
  className = 'mr-0',
  agentsMap,
  context,
  size = 20,
}: {
  conversation: TConversation | TPreset | null;
  endpointsConfig: TEndpointsConfig;
  containerClassName?: string;
  context?: 'message' | 'nav' | 'landing' | 'menu-item';
  agentsMap?: TAgentsMap;
  className?: string;
  size?: number;
}) {
  const convoIconURL = conversation?.iconURL ?? '';
  const originalEndpoint = conversation?.endpoint;
  let endpoint = originalEndpoint;
  endpoint = getIconEndpoint({ endpointsConfig, iconURL: convoIconURL, endpoint });

  const endpointType = getEndpointField(endpointsConfig, endpoint, 'type');
  const endpointIconURL = getEndpointField(endpointsConfig, endpoint, 'iconURL');

  const agent = isAgentsEndpoint(endpoint) ? agentsMap?.[conversation?.agent_id ?? ''] : null;
  const agentAvatar = getAgentAvatarUrl(agent) ?? '';
  const agentName = agent?.name ?? '';
  const entityAvatar = agentAvatar;
  const entityName = agentName || '';
  const hasCustomIcon =
    isImageURL(convoIconURL) || (convoIconURL !== '' && convoIconURL !== originalEndpoint);

  const iconURL = hasCustomIcon ? convoIconURL : entityAvatar || convoIconURL;

  if (isImageURL(iconURL)) {
    return (
      <ConvoIconURL
        iconURL={iconURL}
        modelLabel={entityName || conversation?.chatGptLabel || conversation?.modelLabel || ''}
        context={context}
        endpointIconURL={endpointIconURL}
        agentAvatar={agentAvatar}
        agentName={agentName}
      />
    );
  } else {
    return (
      <MinimalIcon
        iconURL={endpointIconURL}
        endpoint={endpoint}
        endpointType={endpointType}
        model={conversation?.model}
        error={false}
        className={className}
        size={size}
        isCreatedByUser={false}
        chatGptLabel={undefined}
        modelLabel={undefined}
      />
    );
  }
}
