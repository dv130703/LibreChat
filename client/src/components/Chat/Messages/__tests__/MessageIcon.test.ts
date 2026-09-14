import type { Agent } from 'librechat-data-provider';
import type { TMessageIcon } from '~/common';

// Mock all module-level imports so we can import the pure arePropsEqual function
// without pulling in React component dependencies
jest.mock('librechat-data-provider', () => ({
  getEndpointField: jest.fn(),
}));
jest.mock('~/components/Endpoints/ConvoIconURL', () => jest.fn());
jest.mock('~/data-provider', () => ({ useGetEndpointsQuery: jest.fn(() => ({ data: {} })) }));
jest.mock('~/utils', () => ({ getIconEndpoint: jest.fn(), logger: { log: jest.fn() } }));
jest.mock('~/components/Endpoints/Icon', () => jest.fn());

import { arePropsEqual } from '../MessageIcon';

const baseIconData: TMessageIcon = {
  endpoint: 'agents',
  model: 'agent_123',
  iconURL: '/images/avatar.png',
  modelLabel: 'Test Agent',
  isCreatedByUser: false,
};

const makeAgent = (overrides?: Partial<Agent>): Agent =>
  ({
    id: 'agent_123',
    name: 'Atlas',
    avatar: { filepath: '/avatars/atlas.png' },
    ...overrides,
  }) as Agent;

describe('MessageIcon arePropsEqual', () => {
  it('returns true when agent reference changes but display fields are identical', () => {
    const agent1 = makeAgent();
    const agent2 = makeAgent();
    expect(agent1).not.toBe(agent2);
    expect(
      arePropsEqual(
        { iconData: baseIconData, agent: agent1 },
        { iconData: baseIconData, agent: agent2 },
      ),
    ).toBe(true);
  });

  it('returns false when agent name changes', () => {
    expect(
      arePropsEqual(
        { iconData: baseIconData, agent: makeAgent({ name: 'Atlas' }) },
        { iconData: baseIconData, agent: makeAgent({ name: 'Hermes' }) },
      ),
    ).toBe(false);
  });

  it('returns false when agent avatar filepath changes', () => {
    expect(
      arePropsEqual(
        {
          iconData: baseIconData,
          agent: makeAgent({ avatar: { filepath: '/a.png', source: 'local' } }),
        },
        {
          iconData: baseIconData,
          agent: makeAgent({ avatar: { filepath: '/b.png', source: 'local' } }),
        },
      ),
    ).toBe(false);
  });

  it('returns true when iconData reference changes but fields are identical', () => {
    const iconData1 = { ...baseIconData };
    const iconData2 = { ...baseIconData };
    expect(
      arePropsEqual(
        { iconData: iconData1, agent: makeAgent() },
        { iconData: iconData2, agent: makeAgent() },
      ),
    ).toBe(true);
  });

  it('returns false when iconData endpoint changes', () => {
    expect(
      arePropsEqual(
        { iconData: { ...baseIconData, endpoint: 'agents' } },
        { iconData: { ...baseIconData, endpoint: 'openAI' } },
      ),
    ).toBe(false);
  });

  it('returns false when iconData iconURL changes', () => {
    expect(
      arePropsEqual(
        { iconData: { ...baseIconData, iconURL: '/a.png' } },
        { iconData: { ...baseIconData, iconURL: '/b.png' } },
      ),
    ).toBe(false);
  });

  it('returns true when agent is undefined', () => {
    expect(arePropsEqual({ iconData: baseIconData }, { iconData: baseIconData })).toBe(true);
  });

  // avatarURL and display strings both remain '' in both states — nothing renders differently,
  // so suppressing the re-render is correct even though the agent prop went from undefined to defined.
  it('returns true when agent transitions from undefined to object with undefined display fields', () => {
    const agentNoFields = makeAgent({ name: undefined, avatar: undefined });
    expect(
      arePropsEqual(
        { iconData: baseIconData, agent: undefined },
        { iconData: baseIconData, agent: agentNoFields },
      ),
    ).toBe(true);
  });

  it('returns false when agent transitions from defined to undefined', () => {
    expect(
      arePropsEqual(
        { iconData: baseIconData, agent: makeAgent() },
        { iconData: baseIconData, agent: undefined },
      ),
    ).toBe(false);
  });
});
