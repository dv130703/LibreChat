import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import { getModelSpecIconURL } from '../endpoints';

describe('getModelSpecIconURL', () => {
  it('returns the explicit model spec icon before preset values', () => {
    const modelSpec = {
      name: 'gemini-test',
      label: 'Gemini Test',
      iconURL: 'google',
      preset: {
        endpoint: EModelEndpoint.custom,
        iconURL: 'anthropic',
      },
    } as TModelSpec;

    expect(getModelSpecIconURL(modelSpec)).toBe('google');
  });

  it('falls back to the preset icon URL when no spec icon is defined', () => {
    const modelSpec = {
      name: 'gemini-test',
      label: 'Gemini Test',
      preset: {
        endpoint: 'google',
        iconURL: EModelEndpoint.custom,
      },
    } as TModelSpec;

    expect(getModelSpecIconURL(modelSpec)).toBe(EModelEndpoint.custom);
  });

  it('falls back to the preset endpoint when no icon URL is defined', () => {
    const modelSpec = {
      name: 'gemini-test',
      label: 'Gemini Test',
      preset: {
        endpoint: 'google',
      },
    } as TModelSpec;

    expect(getModelSpecIconURL(modelSpec)).toBe('google');
  });

  it('returns an empty icon when a runtime model spec is missing preset data', () => {
    const modelSpec = {
      name: 'gemini-test',
      label: 'Gemini Test',
    } as TModelSpec;

    expect(getModelSpecIconURL(modelSpec)).toBe('');
  });
});
