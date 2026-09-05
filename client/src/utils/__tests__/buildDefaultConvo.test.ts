import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import buildDefaultConvo from '../buildDefaultConvo';

jest.mock('../localStorage', () => ({
  getLocalStorageItems: jest.fn(() => ({
    lastSelectedModel: {},
    lastSelectedTools: [],
    lastConversationSetup: {},
  })),
}));

const baseConversation: TConversation = {
  conversationId: 'test-convo-id',
  title: 'Test Conversation',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  endpoint: null,
};

describe('buildDefaultConvo - defaultParamsEndpoint', () => {
  describe('custom endpoint with defaultParamsEndpoint: anthropic', () => {
    const models = ['anthropic/claude-opus-4.5', 'anthropic/claude-sonnet-4'];

    it('should strip maxOutputTokens without defaultParamsEndpoint', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'anthropic/claude-opus-4.5',
        temperature: 0.7,
        maxOutputTokens: 8192,
      };

      const result = buildDefaultConvo({
        models,
        conversation: baseConversation,
        endpoint: 'AnthropicClaude' as EModelEndpoint,
        lastConversationSetup: preset,
      });

      expect(result.maxOutputTokens).toBeUndefined();
      expect(result.temperature).toBe(0.7);
    });
  });

  describe('custom endpoint without defaultParamsEndpoint (OpenAI default)', () => {
    const models = ['gpt-4o', 'gpt-4.1'];

    it('should preserve OpenAI fields and strip anthropic fields', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'MyOpenRouterEndpoint' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        max_tokens: 4096,
        top_p: 0.9,
        maxOutputTokens: 8192,
      };

      const result = buildDefaultConvo({
        models,
        conversation: baseConversation,
        endpoint: 'MyOpenRouterEndpoint' as EModelEndpoint,
        lastConversationSetup: preset,
      });

      expect(result.max_tokens).toBe(4096);
      expect(result.top_p).toBe(0.9);
      expect(result.temperature).toBe(0.7);
      expect(result.maxOutputTokens).toBeUndefined();
    });
  });

  describe('cross-endpoint field isolation', () => {
    it('should not carry bedrock region to a custom endpoint', () => {
      const preset: TConversation = {
        ...baseConversation,
        endpoint: 'MyChatEndpoint' as EModelEndpoint,
        endpointType: EModelEndpoint.custom,
        model: 'gpt-4o',
        temperature: 0.7,
        region: 'us-east-1',
      };

      const result = buildDefaultConvo({
        models: ['gpt-4o'],
        conversation: baseConversation,
        endpoint: 'MyChatEndpoint' as EModelEndpoint,
        lastConversationSetup: preset,
      });

      expect(result.region).toBeUndefined();
      expect(result.temperature).toBe(0.7);
    });
  });
});
