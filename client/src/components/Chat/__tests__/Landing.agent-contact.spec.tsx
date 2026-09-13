import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import Landing from '../Landing';

let mockConversation: Record<string, unknown> | null = null;
let mockAgentsMap: Record<string, any> | undefined;

jest.mock('@react-spring/web', () => ({
  easings: {
    easeOutCubic: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    azureOpenAI: 'azureOpenAI',
    openAI: 'openAI',
  },
}));

jest.mock(
  '@librechat/client',
  () => ({
    BirthdayIcon: () => <span data-testid="birthday-icon" />,
    TooltipAnchor: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    SplitText: ({ text }: { text: string }) => <span>{text}</span>,
  }),
  { virtual: true },
);

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation }),
  useAgentsMapContext: () => mockAgentsMap,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: {} } }),
  useGetEndpointsQuery: () => ({ data: {} }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: undefined }),
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_agents_contact: 'Contact',
      com_agents_no_contact_available: 'No contact available',
      com_ui_good_morning: 'Good morning',
      com_ui_good_afternoon: 'Good afternoon',
      com_ui_good_evening: 'Good evening',
      com_ui_late_night: 'Good evening',
      com_ui_weekend_morning: 'Good morning',
    };
    return translations[key] || key;
  },
}));

jest.mock('~/utils', () => ({
  CONFIG_HTML_MEDIA_ATTR: {},
  CONFIG_HTML_MEDIA_TAGS: [],
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
  createConfigHtmlSanitizer: () => (html: string) => html,
  getIconEndpoint: ({ endpoint }: { endpoint: string }) => endpoint,
  getModelSpec: () => undefined,
  getEntity: ({
    endpoint,
    agentsMap,
    agent_id,
  }: {
    endpoint: string;
    agentsMap?: Record<string, any>;
    agent_id?: string;
  }) => {
    if (endpoint === 'agents' && agent_id != null) {
      return { entity: agentsMap?.[agent_id], isAgent: true };
    }
    return { entity: undefined, isAgent: false };
  },
}));

jest.mock('~/components/Endpoints/ConvoIcon', () => () => <span data-testid="convo-icon" />);

describe('Landing agent contact', () => {
  beforeEach(() => {
    mockConversation = null;
    mockAgentsMap = undefined;
  });

  it('shows contact for the selected agent from agentsMap', () => {
    mockConversation = {
      endpoint: 'agents',
      agent_id: 'agent-1',
    };
    mockAgentsMap = {
      'agent-1': {
        id: 'agent-1',
        name: 'Portal Remote Agent',
        description: 'Remote Agent Showcase',
        owner_contact: { name: 'Owner User', email: 'owner@example.com' },
      },
    };

    render(<Landing centerFormOnLanding={false} />);

    expect(screen.getByText('Portal Remote Agent')).toBeInTheDocument();
    expect(screen.getByText('Remote Agent Showcase')).toBeInTheDocument();
    expect(screen.getByText('Contact:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Owner User' })).toHaveAttribute(
      'href',
      'mailto:owner@example.com',
    );
  });

  it('does not show contact when the selected agent is missing from agentsMap', () => {
    mockConversation = {
      endpoint: 'agents',
      agent_id: 'missing-agent',
      greeting: 'Start chatting',
    };
    mockAgentsMap = {};

    render(<Landing centerFormOnLanding={false} />);

    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
    expect(screen.queryByText('No contact available')).not.toBeInTheDocument();
  });
});
