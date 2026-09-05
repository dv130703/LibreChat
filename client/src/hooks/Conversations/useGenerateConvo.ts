import { useRecoilValue } from 'recoil';
import { useCallback, useRef, useEffect } from 'react';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import { getEndpointField, getDefaultParamsEndpoint } from 'librechat-data-provider';
import type {
  TEndpointsConfig,
  EModelEndpoint,
  TModelsConfig,
  TConversation,
  TPreset,
} from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import { buildDefaultConvo, getDefaultEndpoint, logger } from '~/utils';
import { useGetEndpointsQuery } from '~/data-provider';
import { mainTextareaId } from '~/common';
import store from '~/store';

const useGenerateConvo = ({
  index = 0,
  rootIndex,
  setConversation,
}: {
  index?: number;
  rootIndex: number;
  setConversation?: SetterOrUpdater<TConversation | null>;
}) => {
  const modelsQuery = useGetModelsQuery();
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();

  const timeoutIdRef = useRef<NodeJS.Timeout>();
  const rootConvo = useRecoilValue(store.conversationByKeySelector(rootIndex));

  useEffect(() => {
    if (rootConvo?.conversationId != null && setConversation) {
      setConversation((prevState) => {
        if (!prevState) {
          return prevState;
        }
        const update = {
          ...prevState,
          conversationId: rootConvo.conversationId,
        } as TConversation;

        logger.log('conversation', 'Setting conversation from `useNewConvo`', update);
        return update;
      });
    }
  }, [rootConvo?.conversationId, setConversation]);

  const generateConversation = useCallback(
    ({
      template = {},
      preset,
      modelsData,
    }: {
      template?: Partial<TConversation>;
      preset?: Partial<TPreset>;
      modelsData?: TModelsConfig;
    } = {}) => {
      let conversation = {
        conversationId: 'new',
        title: 'New Chat',
        endpoint: null,
        ...template,
        createdAt: '',
        updatedAt: '',
      };

      if (rootConvo?.conversationId) {
        conversation.conversationId = rootConvo.conversationId;
      }

      const modelsConfig = modelsData ?? modelsQuery.data;

      const defaultEndpoint = getDefaultEndpoint({
        convoSetup: preset ?? conversation,
        endpointsConfig,
      });

      const endpointType = getEndpointField(endpointsConfig, defaultEndpoint, 'type');
      if (!conversation.endpointType && endpointType) {
        conversation.endpointType = endpointType;
      } else if (conversation.endpointType && !endpointType) {
        conversation.endpointType = undefined;
      }

      if (conversation.assistant_id != null) {
        conversation.assistant_id = undefined;
      }

      const models = modelsConfig?.[defaultEndpoint ?? ''] ?? [];
      const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, defaultEndpoint);
      conversation = buildDefaultConvo({
        conversation,
        lastConversationSetup: preset as TConversation,
        endpoint: defaultEndpoint ?? ('' as EModelEndpoint),
        models,
        defaultParamsEndpoint,
      });

      if (preset?.title != null && preset.title !== '') {
        conversation.title = preset.title;
      }

      if (setConversation) {
        setConversation(conversation);
      }

      clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = setTimeout(() => {
        const textarea = document.getElementById(mainTextareaId);
        if (textarea) {
          textarea.focus();
        }
      }, 150);
      return conversation;
    },
    [endpointsConfig, modelsQuery.data, rootConvo, setConversation],
  );

  return { generateConversation };
};

export default useGenerateConvo;
