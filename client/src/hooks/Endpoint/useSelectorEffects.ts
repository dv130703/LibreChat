import React, { useMemo, useEffect } from 'react';
import debounce from 'lodash/debounce';
import { isAgentsEndpoint, LocalStorageKeys, isEphemeralAgentId } from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { SelectedValues } from '~/common';
import useSetIndexOptions from '~/hooks/Conversations/useSetIndexOptions';

export default function useSelectorEffects({
  index = 0,
  agentsMap,
  conversation,
  setSelectedValues,
}: {
  index?: number;
  agentsMap: t.TAgentsMap | undefined;
  conversation: t.TConversation | null;
  setSelectedValues: React.Dispatch<React.SetStateAction<SelectedValues>>;
}) {
  const { setOption } = useSetIndexOptions();
  const agents: t.Agent[] = useMemo(() => {
    return Object.values(agentsMap ?? {}) as t.Agent[];
  }, [agentsMap]);
  const { agent_id: selectedAgentId = null, endpoint } = conversation ?? {};

  useEffect(() => {
    if (!isAgentsEndpoint(endpoint as string)) {
      return;
    }
    if (selectedAgentId == null && agents.length > 0) {
      let agent_id = localStorage.getItem(`${LocalStorageKeys.AGENT_ID_PREFIX}${index}`);
      if (agent_id == null || isEphemeralAgentId(agent_id)) {
        agent_id = agents[0]?.id;
      }
      const agent = agentsMap?.[agent_id];

      if (agent !== undefined) {
        setOption('model')('');
        setOption('agent_id')(agent_id);
      }
    }
  }, [index, agents, selectedAgentId, agentsMap, endpoint, setOption]);

  const debouncedSetSelectedValues = useMemo(
    () => debounce(setSelectedValues, 150),
    [setSelectedValues],
  );

  useEffect(() => {
    if (!conversation?.endpoint) {
      return;
    }
    if (
      conversation?.assistant_id ||
      conversation?.agent_id ||
      conversation?.model ||
      conversation?.spec
    ) {
      if (isAgentsEndpoint(conversation?.endpoint)) {
        debouncedSetSelectedValues({
          endpoint: conversation.endpoint || '',
          model: conversation.agent_id ?? '',
          modelSpec: conversation.spec || '',
        });
        return;
      }
      debouncedSetSelectedValues({
        endpoint: conversation.endpoint || '',
        model: conversation.model || '',
        modelSpec: conversation.spec || '',
      });
    }
    return () => {
      debouncedSetSelectedValues.cancel();
    };
  }, [
    conversation?.spec,
    conversation?.model,
    conversation?.endpoint,
    conversation?.agent_id,
    conversation?.assistant_id,
    debouncedSetSelectedValues,
  ]);
}
