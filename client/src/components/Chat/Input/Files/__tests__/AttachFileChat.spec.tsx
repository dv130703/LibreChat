import React from 'react';
import { render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, Providers, mergeFileConfig } from 'librechat-data-provider';
import type { TEndpointsConfig, Agent } from 'librechat-data-provider';
import AttachFileChat from '../AttachFileChat';

const mockEndpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.custom]: { userProvide: false, order: 0 },
  [EModelEndpoint.agents]: { userProvide: false, order: 1 },
  ['assistants']: { userProvide: false, order: 2 },
  Moonshot: { type: EModelEndpoint.custom, userProvide: false, order: 9999 },
};

const defaultFileConfig = mergeFileConfig({
  endpoints: {
    Moonshot: { fileLimit: 5 },
    [EModelEndpoint.agents]: { fileLimit: 20 },
    default: { fileLimit: 10 },
  },
});

let mockFileConfig = defaultFileConfig;

let mockAgentsMap: Record<string, Partial<Agent>> = {};
let mockAgentQueryData: Partial<Agent> | undefined;

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
  useGetFileConfig: ({ select }: { select?: (data: unknown) => unknown }) => ({
    data: select != null ? select(mockFileConfig) : mockFileConfig,
  }),
  useGetAgentByIdQuery: () => ({ data: mockAgentQueryData }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => mockAgentsMap,
}));

/** Capture the props passed to AttachFileMenu */
let mockAttachFileMenuProps: Record<string, unknown> = {};
jest.mock('../AttachFileMenu', () => {
  return function MockAttachFileMenu(props: Record<string, unknown>) {
    mockAttachFileMenuProps = props;
    return <div data-testid="attach-file-menu" data-endpoint-type={String(props.endpointType)} />;
  };
});

jest.mock('../AttachFile', () => {
  return function MockAttachFile() {
    return <div data-testid="attach-file" />;
  };
});

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderComponent(
  conversation: Record<string, unknown> | null,
  disableInputs = false,
  extraProps: Record<string, unknown> = {},
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AttachFileChat
          conversation={conversation as never}
          disableInputs={disableInputs}
          files={new Map()}
          setFiles={() => {}}
          setFilesLoading={() => {}}
          {...extraProps}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('AttachFileChat', () => {
  beforeEach(() => {
    mockFileConfig = defaultFileConfig;
    mockAgentsMap = {};
    mockAgentQueryData = undefined;
    mockAttachFileMenuProps = {};
  });

  describe('rendering decisions', () => {
    it('renders AttachFileMenu for agents endpoint', () => {
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(screen.getByTestId('attach-file-menu')).toBeInTheDocument();
    });

    it('renders AttachFileMenu for custom endpoint with file support', () => {
      renderComponent({ endpoint: 'Moonshot' });
      expect(screen.getByTestId('attach-file-menu')).toBeInTheDocument();
    });

    it('renders null for null conversation', () => {
      const { container } = renderComponent(null);
      expect(container.innerHTML).toBe('');
    });
  });

  describe('endpointType resolution for agents', () => {
    it('passes custom endpointType when agent provider is a custom endpoint', () => {
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });

    it('passes openAI endpointType when agent provider is openAI', () => {
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.custom, model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });

    it('passes agents endpointType when no agent provider', () => {
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.agents);
    });

    it('passes agents endpointType when no agent_id', () => {
      renderComponent({ endpoint: EModelEndpoint.agents });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.agents);
    });

    it('uses agentData query when agent not in agentsMap', () => {
      mockAgentQueryData = { provider: 'Moonshot' } as Partial<Agent>;
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-2' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });

    it('falls back to agentsMap provider when fetched agent omits provider', () => {
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.custom, model_parameters: {} } as Partial<Agent>,
      };
      mockAgentQueryData = {} as Partial<Agent>;
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });
  });

  describe('endpointType resolution for non-agents', () => {
    it('passes custom endpointType for a custom endpoint', () => {
      renderComponent({ endpoint: 'Moonshot' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });

    it('passes openAI endpointType for openAI endpoint', () => {
      renderComponent({ endpoint: EModelEndpoint.custom });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });
  });

  describe('consistency: same endpoint type for direct vs agent usage', () => {
    it('resolves Moonshot the same way whether used directly or through an agent', () => {
      renderComponent({ endpoint: 'Moonshot' });
      const directType = mockAttachFileMenuProps.endpointType;

      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      const agentType = mockAttachFileMenuProps.endpointType;

      expect(directType).toBe(agentType);
    });
  });

  describe('upload disabled rendering', () => {
    it('renders null for agents endpoint when fileConfig.agents.disabled is true', () => {
      mockFileConfig = mergeFileConfig({
        endpoints: {
          [EModelEndpoint.agents]: { disabled: true },
        },
      });
      const { container } = renderComponent({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
      });
      expect(container.innerHTML).toBe('');
    });

    it('renders null for agents endpoint when disableInputs is true', () => {
      const { container } = renderComponent(
        { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' },
        true,
      );
      expect(container.innerHTML).toBe('');
    });

    it('renders AttachFileMenu when provider-specific config overrides agents disabled', () => {
      mockFileConfig = mergeFileConfig({
        endpoints: {
          Moonshot: { disabled: false, fileLimit: 5 },
          [EModelEndpoint.agents]: { disabled: true },
        },
      });
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(screen.getByTestId('attach-file-menu')).toBeInTheDocument();
    });

    it('renders null for assistants endpoint when fileConfig.assistants.disabled is true', () => {
      mockFileConfig = mergeFileConfig({
        endpoints: {
          ['assistants']: { disabled: true },
        },
      });
      const { container } = renderComponent({
        endpoint: 'assistants',
      });
      expect(container.innerHTML).toBe('');
    });
  });

  describe(
    'forwards setConversation/latestMessageId to AttachFileMenu - regression: this is the ' +
      'component every non-assistants attach path renders, and it used to drop both props ' +
      'entirely rather than passing them through from its own caller (ChatForm.tsx). See ' +
      "AttachFileMenu.spec.tsx's matching test for the full failure-mode explanation.",
    () => {
      it('passes both through unchanged', () => {
        const setConversation = jest.fn();
        renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }, false, {
          setConversation,
          latestMessageId: 'leaf-message-id',
        });
        expect(mockAttachFileMenuProps.setConversation).toBe(setConversation);
        expect(mockAttachFileMenuProps.latestMessageId).toBe('leaf-message-id');
      });
    },
  );

  describe('endpointFileConfig resolution', () => {
    it('passes Moonshot-specific file config for agent with Moonshot provider', () => {
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      const config = mockAttachFileMenuProps.endpointFileConfig as { fileLimit?: number };
      expect(config?.fileLimit).toBe(5);
    });

    it('passes agents file config when agent has no specific provider config', () => {
      mockAgentsMap = {
        'agent-1': { provider: Providers.OPENAI, model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      const config = mockAttachFileMenuProps.endpointFileConfig as { fileLimit?: number };
      expect(config?.fileLimit).toBe(10);
    });

    it('passes agents file config when no agent provider', () => {
      renderComponent({ endpoint: EModelEndpoint.agents });
      const config = mockAttachFileMenuProps.endpointFileConfig as { fileLimit?: number };
      expect(config?.fileLimit).toBe(20);
    });
  });
});
