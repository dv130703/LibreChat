import { EModelEndpoint } from 'librechat-data-provider';
import cleanupPreset from '../cleanupPreset';

/**
 * Integration tests for cleanupPreset — NO mocks.
 * Uses the real parseConvo to verify actual schema behavior
 * for custom endpoints.
 */
describe('cleanupPreset - real parsing', () => {
  it('should strip maxOutputTokens without defaultParamsEndpoint (OpenAI schema)', () => {
    const preset = {
      presetId: 'test-id',
      title: 'GPT Custom',
      endpoint: 'MyOpenRouter',
      endpointType: EModelEndpoint.custom,
      model: 'gpt-4o',
      temperature: 0.7,
      maxOutputTokens: 8192,
      max_tokens: 4096,
    };

    const result = cleanupPreset({ preset });

    expect(result.maxOutputTokens).toBeUndefined();
    expect(result.max_tokens).toBe(4096);
    expect(result.temperature).toBe(0.7);
  });

  it('should not carry bedrock region to custom endpoint', () => {
    const preset = {
      presetId: 'test-id',
      title: 'Custom',
      endpoint: 'MyEndpoint',
      endpointType: EModelEndpoint.custom,
      model: 'gpt-4o',
      temperature: 0.7,
      region: 'us-east-1',
    };

    const result = cleanupPreset({ preset });

    expect(result.region).toBeUndefined();
    expect(result.temperature).toBe(0.7);
  });
});
