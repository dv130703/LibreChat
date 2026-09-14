import { EModelEndpoint } from 'librechat-data-provider';
import { filterMentionEndpoints } from './mentions';

describe('filterMentionEndpoints', () => {
  const endpoints = ['anthropic', 'bedrock', EModelEndpoint.agents];

  it('limits mention endpoints to model spec addedEndpoints', () => {
    const result = filterMentionEndpoints({
      endpoints,
      includedEndpoints: new Set([EModelEndpoint.agents]),
      hasAgentAccess: true,
    });

    expect(result).toEqual([EModelEndpoint.agents]);
  });

  it('keeps provider endpoints when no model spec allow-list is configured', () => {
    const result = filterMentionEndpoints({
      endpoints,
      includedEndpoints: new Set(),
      hasAgentAccess: true,
    });

    expect(result).toEqual(endpoints);
  });

  it('excludes agents when the user lacks agent access', () => {
    const result = filterMentionEndpoints({
      endpoints,
      includedEndpoints: new Set([EModelEndpoint.agents]),
      hasAgentAccess: false,
    });

    expect(result).toEqual([]);
  });

  it('keeps non-agent endpoints', () => {
    const result = filterMentionEndpoints({
      endpoints: ['custom'],
      includedEndpoints: new Set(),
      hasAgentAccess: true,
    });

    expect(result).toEqual(['custom']);
  });
});
