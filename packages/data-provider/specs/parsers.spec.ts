import { replaceSpecialVars, parseConvo, parseCompactConvo, parseTextParts } from '../src/parsers';
import { specialVariables } from '../src/config';
import { EModelEndpoint, Providers } from '../src/schemas';
import { ContentTypes } from '../src/types/runs';
import type { TMessageContentParts } from '../src/types/assistants';
import type { TUser, TConversation } from '../src/types';

// Mock dayjs module with consistent date/time values regardless of environment
jest.mock('dayjs', () => {
  const mockDayjs = (input?: unknown) => ({
    format: (format: string) => {
      if (input === '2023-12-31T23:59:58.000Z') {
        if (format === 'YYYY-MM-DD') {
          return '2023-12-31';
        }
        if (format === 'YYYY-MM-DD HH:mm:ss Z') {
          return '2023-12-31 23:59:58 +00:00';
        }
        if (format === 'dddd') {
          return 'Sunday';
        }
      }
      if (format === 'YYYY-MM-DD') {
        return '2024-04-29';
      }
      if (format === 'YYYY-MM-DD HH:mm:ss Z') {
        return '2024-04-29 12:34:56 -04:00';
      }
      if (format === 'dddd') {
        return 'Monday';
      }
      throw new Error(
        `Unhandled dayjs().format() call in mock: "${format}". Update the mock in parsers.spec.ts`,
      );
    },
    toISOString: () =>
      input === '2023-12-31T23:59:58.000Z'
        ? '2023-12-31T23:59:58.000Z'
        : '2024-04-29T16:34:56.000Z',
  });

  mockDayjs.extend = jest.fn();

  return mockDayjs;
});

describe('replaceSpecialVars', () => {
  // Create a partial user object for testing
  const mockUser = {
    name: 'Test User',
    id: 'user123',
  } as TUser;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should return the original text if text is empty', () => {
    expect(replaceSpecialVars({ text: '' })).toBe('');
    expect(replaceSpecialVars({ text: null as unknown as string })).toBe(null);
    expect(replaceSpecialVars({ text: undefined as unknown as string })).toBe(undefined);
  });

  test('should replace {{current_date}} with the current date', () => {
    const result = replaceSpecialVars({ text: 'Today is {{current_date}}' });
    expect(result).toBe('Today is 2024-04-29 (Monday)');
  });

  test('should replace {{current_datetime}} with the current datetime', () => {
    const result = replaceSpecialVars({ text: 'Now is {{current_datetime}}' });
    expect(result).toBe('Now is 2024-04-29 12:34:56 -04:00 (Monday)');
  });

  test('should replace {{iso_datetime}} with the ISO datetime', () => {
    const result = replaceSpecialVars({ text: 'ISO time: {{iso_datetime}}' });
    expect(result).toBe('ISO time: 2024-04-29T16:34:56.000Z');
  });

  test('should use supplied anchor time for date variables', () => {
    const result = replaceSpecialVars({
      text: '{{current_date}} | {{current_datetime}} | {{iso_datetime}}',
      now: '2023-12-31T23:59:58.000Z',
    });
    expect(result).toBe(
      '2023-12-31 (Sunday) | 2023-12-31 23:59:58 +00:00 (Sunday) | 2023-12-31T23:59:58.000Z',
    );
  });

  test('should replace special variables with surrounding whitespace', () => {
    const result = replaceSpecialVars({
      text: '{{ current_date }} | {{ current_user }}',
      user: mockUser,
    });

    expect(result).toBe('2024-04-29 (Monday) | Test User');
  });

  test('should replace {{current_user}} with the user name if provided', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}!',
      user: mockUser,
    });
    expect(result).toBe('Hello Test User!');
  });

  test('should not replace {{current_user}} if user is not provided', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}!',
    });
    expect(result).toBe('Hello {{current_user}}!');
  });

  test('should not replace {{current_user}} if user has no name', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}!',
      user: { id: 'user123' } as TUser,
    });
    expect(result).toBe('Hello {{current_user}}!');
  });

  test('should handle multiple replacements in the same text', () => {
    const result = replaceSpecialVars({
      text: 'Hello {{current_user}}! Today is {{current_date}} and the time is {{current_datetime}}. ISO: {{iso_datetime}}',
      user: mockUser,
    });
    expect(result).toBe(
      'Hello Test User! Today is 2024-04-29 (Monday) and the time is 2024-04-29 12:34:56 -04:00 (Monday). ISO: 2024-04-29T16:34:56.000Z',
    );
  });

  test('should be case-insensitive when replacing variables', () => {
    const result = replaceSpecialVars({
      text: 'Date: {{CURRENT_DATE}}, User: {{Current_User}}',
      user: mockUser,
    });
    expect(result).toBe('Date: 2024-04-29 (Monday), User: Test User');
  });

  test('should confirm all specialVariables from config.ts get parsed', () => {
    // Create a text that includes all special variables
    const specialVarsText = Object.keys(specialVariables)
      .map((key) => `{{${key}}}`)
      .join(' ');

    const result = replaceSpecialVars({
      text: specialVarsText,
      user: mockUser,
    });

    // Verify none of the original variable placeholders remain in the result
    Object.keys(specialVariables).forEach((key) => {
      const placeholder = `{{${key}}}`;
      expect(result).not.toContain(placeholder);
    });

    // Verify the expected replacements
    expect(result).toContain('2024-04-29 (Monday)'); // current_date
    expect(result).toContain('2024-04-29 12:34:56 -04:00 (Monday)'); // current_datetime
    expect(result).toContain('2024-04-29T16:34:56.000Z'); // iso_datetime
    expect(result).toContain('Test User'); // current_user
  });
});

describe('parseCompactConvo', () => {
  describe('iconURL security sanitization', () => {
    test('should strip iconURL from OpenAI endpoint conversation input', () => {
      const maliciousIconURL = 'https://evil-tracker.example.com/pixel.png?user=victim';
      const conversation: Partial<TConversation> = {
        model: 'gpt-4',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.custom,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.custom,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gpt-4');
    });

    test('should strip iconURL from agents endpoint conversation input', () => {
      const maliciousIconURL = 'https://evil-tracker.example.com/pixel.png';
      const conversation: Partial<TConversation> = {
        agent_id: 'agent_123',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.agents,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.agents,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.agent_id).toBe('agent_123');
    });

    test('should strip iconURL from anthropic endpoint conversation input', () => {
      const maliciousIconURL = 'https://tracker.malicious.com/beacon.gif';
      const conversation: Partial<TConversation> = {
        model: 'claude-3-opus',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.custom,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.custom,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('claude-3-opus');
    });

    test('should strip iconURL from google endpoint conversation input', () => {
      const maliciousIconURL = 'https://tracking.example.com/spy.png';
      const conversation: Partial<TConversation> = {
        model: 'gemini-pro',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.custom,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.custom,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gemini-pro');
    });

    test('should strip iconURL from a second custom endpoint conversation input', () => {
      const maliciousIconURL = 'https://evil.com/track.png';
      const conversation: Partial<TConversation> = {
        model: 'llama3.2',
        iconURL: maliciousIconURL,
        endpoint: EModelEndpoint.custom,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.custom,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('llama3.2');
    });

    test('should preserve other conversation properties while stripping iconURL', () => {
      const conversation: Partial<TConversation> = {
        model: 'gpt-4',
        iconURL: 'https://malicious.com/track.png',
        endpoint: EModelEndpoint.custom,
        temperature: 0.7,
        top_p: 0.9,
        promptPrefix: 'You are a helpful assistant.',
        maxContextTokens: 4000,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.custom,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gpt-4');
      expect(result?.temperature).toBe(0.7);
      expect(result?.top_p).toBe(0.9);
      expect(result?.promptPrefix).toBe('You are a helpful assistant.');
      expect(result?.maxContextTokens).toBe(4000);
    });

    test('should handle conversation without iconURL (no error)', () => {
      const conversation: Partial<TConversation> = {
        model: 'gpt-4',
        endpoint: EModelEndpoint.custom,
      };

      const result = parseCompactConvo({
        endpoint: EModelEndpoint.custom,
        conversation,
      });

      expect(result).not.toBeNull();
      expect(result?.['iconURL']).toBeUndefined();
      expect(result?.model).toBe('gpt-4');
    });
  });
});

describe('parseTextParts', () => {
  test('should concatenate text parts', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Hello' },
      { type: ContentTypes.TEXT, text: 'World' },
    ];
    expect(parseTextParts(parts)).toBe('Hello World');
  });

  test('should handle text parts with object-style text values', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: { value: 'structured text' } },
    ];
    expect(parseTextParts(parts)).toBe('structured text');
  });

  test('should include think parts by default', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Answer:' },
      { type: ContentTypes.THINK, think: 'reasoning step' },
    ];
    expect(parseTextParts(parts)).toBe('Answer: reasoning step');
  });

  test('should skip think parts when skipReasoning is true', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.THINK, think: 'internal reasoning' },
      { type: ContentTypes.TEXT, text: 'visible answer' },
    ];
    expect(parseTextParts(parts, true)).toBe('visible answer');
  });

  test('should skip non-text/think part types', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'before' },
      { type: ContentTypes.IMAGE_FILE } as TMessageContentParts,
      { type: ContentTypes.TEXT, text: 'after' },
    ];
    expect(parseTextParts(parts)).toBe('before after');
  });

  test('should handle undefined elements in the content parts array', () => {
    const parts: Array<TMessageContentParts | undefined> = [
      { type: ContentTypes.TEXT, text: 'first' },
      undefined,
      { type: ContentTypes.TEXT, text: 'third' },
    ];
    expect(parseTextParts(parts)).toBe('first third');
  });

  test('should handle multiple consecutive undefined elements', () => {
    const parts: Array<TMessageContentParts | undefined> = [
      undefined,
      undefined,
      { type: ContentTypes.TEXT, text: 'only text' },
      undefined,
    ];
    expect(parseTextParts(parts)).toBe('only text');
  });

  test('should handle an array of all undefined elements', () => {
    const parts: Array<TMessageContentParts | undefined> = [undefined, undefined, undefined];
    expect(parseTextParts(parts)).toBe('');
  });

  test('should handle parts with missing type property', () => {
    const parts: Array<TMessageContentParts | undefined> = [
      { text: 'no type field' } as unknown as TMessageContentParts,
      { type: ContentTypes.TEXT, text: 'valid' },
    ];
    expect(parseTextParts(parts)).toBe('valid');
  });

  test('should return empty string for empty array', () => {
    expect(parseTextParts([])).toBe('');
  });

  test('should not add extra spaces when parts already have spacing', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'Hello ' },
      { type: ContentTypes.TEXT, text: 'World' },
    ];
    expect(parseTextParts(parts)).toBe('Hello World');
  });

  test('should exclude steer parts by default (generic extraction must not speak user words)', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'assistant output' },
      { type: ContentTypes.STEER, steer: 'user mid-run words' },
      { type: ContentTypes.TEXT, text: 'more output' },
    ];
    expect(parseTextParts(parts)).toBe('assistant output more output');
  });

  test('should include steer parts when includeSteer is set', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.TEXT, text: 'assistant output' },
      { type: ContentTypes.STEER, steer: 'user mid-run words' },
    ];
    expect(parseTextParts(parts, false, { includeSteer: true })).toBe(
      'assistant output user mid-run words',
    );
  });

  test('should combine includeSteer with skipReasoning', () => {
    const parts: TMessageContentParts[] = [
      { type: ContentTypes.THINK, think: 'internal reasoning' },
      { type: ContentTypes.TEXT, text: 'visible answer' },
      { type: ContentTypes.STEER, steer: 'steered words' },
    ];
    expect(parseTextParts(parts, true, { includeSteer: true })).toBe(
      'visible answer steered words',
    );
  });
});
