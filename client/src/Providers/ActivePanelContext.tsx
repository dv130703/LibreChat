import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react';

const STORAGE_KEY = 'side:active-panel';
export const DEFAULT_PANEL = 'conversations';

function getInitialActivePanel(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? saved : DEFAULT_PANEL;
}

interface ActivePanelContextType {
  active: string;
  setActive: (id: string) => void;
}

const ActivePanelContext = createContext<ActivePanelContextType | undefined>(undefined);

export function ActivePanelProvider({ children }: { children: ReactNode }) {
  const [active, _setActive] = useState<string>(getInitialActivePanel);

  const setActive = useCallback((id: string) => {
    localStorage.setItem(STORAGE_KEY, id);
    _setActive(id);
  }, []);

  const value = useMemo(() => ({ active, setActive }), [active, setActive]);

  return <ActivePanelContext.Provider value={value}>{children}</ActivePanelContext.Provider>;
}

export function useActivePanel() {
  const context = useContext(ActivePanelContext);
  if (context === undefined) {
    throw new Error('useActivePanel must be used within an ActivePanelProvider');
  }
  return context;
}

/** Returns `active` when it matches a known link that renders in-panel content,
 * otherwise the first such link's id. Links without a `Component` (e.g. `onClick`-only
 * navigation links) never count as "open," so a stale `active` pointing at one falls back. */
export function resolveActivePanel(
  active: string,
  links: { id: string; Component?: unknown }[],
): string {
  if (links.some((l) => l.id === active && l.Component != null)) {
    return active;
  }
  return links.find((l) => l.Component != null)?.id ?? active;
}

/**
 * The link whose full page the browser is currently on, if any.
 *
 * `resolveActivePanel` deliberately only ever returns links that render a
 * panel inside the sidebar, which left links that navigate to a full page
 * (Agent Builder, Information Management) unable to show as selected at all -
 * the highlight fell through to the first panel instead, lighting
 * Conversations while the user was somewhere else entirely. Only the route
 * knows, so it decides for those links.
 *
 * Matches on a path prefix because these pages have sub-routes
 * (`/agents/builder/new`, `/agents/builder/:agentId`) that are all still the
 * same destination. Longest path wins, so a more specific link is not
 * shadowed by a shorter one that happens to be its prefix.
 */
export function resolveRouteActiveId(
  links: { id: string; path?: string }[],
  pathname: string,
): string | undefined {
  let match: { id: string; path: string } | undefined;
  for (const link of links) {
    if (link.path == null || !pathname.startsWith(link.path)) {
      continue;
    }
    if (match == null || link.path.length > match.path.length) {
      match = { id: link.id, path: link.path };
    }
  }
  return match?.id;
}
