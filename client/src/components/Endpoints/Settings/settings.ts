import { EModelEndpoint } from 'librechat-data-provider';
import type { FC } from 'react';
import type { TModelSelectProps } from '~/common';
import OpenAISettings from './OpenAI';

const settings: { [key: string]: FC<TModelSelectProps> | undefined } = {
  [EModelEndpoint.agents]: OpenAISettings,
  [EModelEndpoint.custom]: OpenAISettings,
};

export const getSettings = () => {
  return { settings };
};
