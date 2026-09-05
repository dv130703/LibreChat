import { atom, selector } from 'recoil';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';

const defaultConfig: TEndpointsConfig = {
  [EModelEndpoint.agents]: null,
  [EModelEndpoint.custom]: null,
};

const endpointsConfig = atom<TEndpointsConfig>({
  key: 'endpointsConfig',
  default: defaultConfig,
});

const endpointsQueryEnabled = atom<boolean>({
  key: 'endpointsQueryEnabled',
  default: true,
});

const endpointsFilter = selector({
  key: 'endpointsFilter',
  get: ({ get }) => {
    const config = get(endpointsConfig) || {};

    const filter = {};
    for (const key of Object.keys(config)) {
      filter[key] = !!config[key];
    }
    return filter;
  },
});

export default {
  endpointsConfig,
  endpointsFilter,
  defaultConfig,
  endpointsQueryEnabled,
};
