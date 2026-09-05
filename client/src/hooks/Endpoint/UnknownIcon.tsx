import { memo } from 'react';
import { EModelEndpoint, KnownEndpoints } from 'librechat-data-provider';
import { CustomMinimalIcon, XAIcon, MoonshotIcon } from '@librechat/client';
import { IconContext } from '~/common';
import { cn } from '~/utils';

/** Gateway/observability proxy names a user might give their custom
 *  OpenAI-compatible endpoint — decorative only, not native LLM providers. */
const knownEndpointAssets: Record<string, string> = {
  [KnownEndpoints.ollama]: 'assets/ollama.png',
  google: 'assets/google.svg',
  openai: 'assets/openai.svg',
  qwen: 'assets/qwen.svg',
  [KnownEndpoints.openrouter]: 'assets/openrouter.png',
  helicone: 'assets/helicone.svg',
};

const knownEndpointComponents = new Set<string>(['moonshot', 'xai']);

export function getKnownEndpointAsset(endpoint?: string | null): string {
  if (!endpoint) {
    return '';
  }

  return knownEndpointAssets[endpoint.toLowerCase()] ?? '';
}

export function hasKnownEndpointIcon(endpoint?: string | null): boolean {
  if (!endpoint) {
    return false;
  }

  const currentEndpoint = endpoint.toLowerCase();
  return (
    getKnownEndpointAsset(currentEndpoint) !== '' || knownEndpointComponents.has(currentEndpoint)
  );
}

const knownEndpointClasses: Record<string, Record<string, string>> = {};

const getKnownClass = ({
  currentEndpoint,
  context = '',
  className,
}: {
  currentEndpoint: string;
  context?: string;
  className: string;
}) => {
  if (currentEndpoint === KnownEndpoints.openrouter) {
    return className;
  }

  const match = knownEndpointClasses[currentEndpoint]?.[context] ?? '';
  const defaultClass = context === IconContext.landing ? '' : className;

  return cn(match, defaultClass);
};

function UnknownIcon({
  className = '',
  endpoint: _endpoint,
  iconURL = '',
  context,
}: {
  iconURL?: string;
  className?: string;
  endpoint?: EModelEndpoint | string | null;
  context?: 'landing' | 'menu-item' | 'nav' | 'message';
}) {
  const endpoint = _endpoint ?? '';
  if (!endpoint) {
    return <CustomMinimalIcon className={className} />;
  }

  const currentEndpoint = endpoint.toLowerCase();

  if (currentEndpoint === 'xai') {
    return <XAIcon className={cn(className, 'text-black dark:text-white')} />;
  }

  if (currentEndpoint === 'moonshot') {
    return <MoonshotIcon className={cn(className, 'text-black dark:text-white')} />;
  }

  if (iconURL) {
    return <img className={className} src={iconURL} alt={`${endpoint} Icon`} />;
  }

  const assetPath = getKnownEndpointAsset(currentEndpoint);

  if (!assetPath) {
    return <CustomMinimalIcon className={className} />;
  }

  return (
    <img
      className={getKnownClass({
        currentEndpoint,
        context: context,
        className,
      })}
      src={assetPath}
      alt={`${currentEndpoint} Icon`}
    />
  );
}

export default memo(UnknownIcon);
