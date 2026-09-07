import { memo, useMemo } from 'react';
import {
  Constants,
  supportsFiles,
  mergeFileConfig,
  isAgentsEndpoint,
  resolveEndpointType,
  isAssistantsEndpoint,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useGetFileConfig, useGetEndpointsQuery, useGetAgentByIdQuery } from '~/data-provider';
import { useAgentsMapContext } from '~/Providers';
import AttachFileMenu from './AttachFileMenu';
import AttachFile from './AttachFile';

function AttachFileChat({
  disableInputs,
  conversation,
  setConversation,
  latestMessageId,
  files,
  setFiles,
  setFilesLoading,
}: {
  disableInputs: boolean;
  conversation: TConversation | null;
  setConversation?: (conversation: TConversation) => void;
  latestMessageId?: string;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const conversationId = conversation?.conversationId ?? Constants.NEW_CONVO;
  const { endpoint } = conversation ?? { endpoint: null };
  const isAgents = useMemo(() => isAgentsEndpoint(endpoint), [endpoint]);
  const isAssistants = useMemo(() => isAssistantsEndpoint(endpoint), [endpoint]);

  const agentsMap = useAgentsMapContext();

  const needsAgentFetch = useMemo(() => {
    if (!isAgents || !conversation?.agent_id) {
      return false;
    }
    const agent = agentsMap?.[conversation.agent_id];
    return !agent?.model_parameters;
  }, [isAgents, conversation?.agent_id, agentsMap]);

  const { data: agentData } = useGetAgentByIdQuery(conversation?.agent_id, {
    enabled: needsAgentFetch,
  });

  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const { data: endpointsConfig } = useGetEndpointsQuery();

  const agentProvider = useMemo(() => {
    if (!isAgents || !conversation?.agent_id) {
      return undefined;
    }
    return agentData?.provider ?? agentsMap?.[conversation.agent_id]?.provider;
  }, [isAgents, conversation?.agent_id, agentData, agentsMap]);

  const endpointType = useMemo(
    () => resolveEndpointType(endpointsConfig, endpoint, agentProvider),
    [endpointsConfig, endpoint, agentProvider],
  );

  const fileConfigEndpoint = useMemo(
    () => (isAgents && agentProvider ? agentProvider : endpoint),
    [isAgents, agentProvider, endpoint],
  );
  const endpointFileConfig = useMemo(
    () =>
      getEndpointFileConfig({
        fileConfig,
        endpointType,
        endpoint: fileConfigEndpoint,
      }),
    [fileConfigEndpoint, fileConfig, endpointType],
  );
  const endpointSupportsFiles: boolean = useMemo(
    () => supportsFiles[endpointType ?? endpoint ?? ''] ?? false,
    [endpointType, endpoint],
  );
  const isUploadDisabled = useMemo(
    () => (disableInputs || endpointFileConfig?.disabled) ?? false,
    [disableInputs, endpointFileConfig?.disabled],
  );

  if (isAssistants && endpointSupportsFiles && !isUploadDisabled) {
    return (
      <AttachFile
        disabled={disableInputs}
        files={files}
        setFiles={setFiles}
        setFilesLoading={setFilesLoading}
        conversation={conversation}
        setConversation={setConversation}
        latestMessageId={latestMessageId}
      />
    );
  } else if ((isAgents || endpointSupportsFiles) && !isUploadDisabled) {
    return (
      <AttachFileMenu
        endpoint={endpoint}
        disabled={disableInputs}
        endpointType={endpointType}
        conversationId={conversationId}
        agentId={conversation?.agent_id}
        endpointFileConfig={endpointFileConfig}
        files={files}
        setFiles={setFiles}
        setFilesLoading={setFilesLoading}
        conversation={conversation}
        setConversation={setConversation}
        latestMessageId={latestMessageId}
      />
    );
  }
  return null;
}

export default memo(AttachFileChat);
