import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import {
  ActivePanelProvider,
  resolveActivePanel,
  resolveRouteActiveId,
  useActivePanel,
} from '~/Providers/ActivePanelContext';

const STORAGE_KEY = 'side:active-panel';

function TestConsumer() {
  const { active, setActive } = useActivePanel();
  return (
    <div>
      <span data-testid="active">{active}</span>
      <button data-testid="switch-btn" onClick={() => setActive('bookmarks')} />
    </div>
  );
}

describe('ActivePanelContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to conversations when no localStorage value exists', () => {
    render(
      <ActivePanelProvider>
        <TestConsumer />
      </ActivePanelProvider>,
    );
    expect(screen.getByTestId('active')).toHaveTextContent('conversations');
  });

  it('reads initial value from localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'memories');
    render(
      <ActivePanelProvider>
        <TestConsumer />
      </ActivePanelProvider>,
    );
    expect(screen.getByTestId('active')).toHaveTextContent('memories');
  });

  it('setActive updates state and writes to localStorage', () => {
    render(
      <ActivePanelProvider>
        <TestConsumer />
      </ActivePanelProvider>,
    );
    fireEvent.click(screen.getByTestId('switch-btn'));
    expect(screen.getByTestId('active')).toHaveTextContent('bookmarks');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('bookmarks');
  });

  it('throws when useActivePanel is called outside provider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      'useActivePanel must be used within an ActivePanelProvider',
    );
    spy.mockRestore();
  });
});

describe('resolveActivePanel', () => {
  const noop = () => {};
  const links = [
    { id: 'conversations', Component: noop },
    { id: 'prompts', Component: noop },
    { id: 'files', Component: noop },
  ];

  it('returns active when it matches a link', () => {
    expect(resolveActivePanel('prompts', links)).toBe('prompts');
  });

  it('falls back to first link when active does not match', () => {
    expect(resolveActivePanel('hide-panel', links)).toBe('conversations');
  });

  it('returns active unchanged when links is empty', () => {
    expect(resolveActivePanel('agents', [])).toBe('agents');
  });

  it('falls back to the only link when active is stale', () => {
    expect(resolveActivePanel('agents', [{ id: 'conversations', Component: noop }])).toBe(
      'conversations',
    );
  });

  it('falls back when active matches a link that has no Component (e.g. an onClick-only navigation link)', () => {
    const linksWithNavOnly = [...links, { id: 'agents' }];
    expect(resolveActivePanel('agents', linksWithNavOnly)).toBe('conversations');
  });

  it('returns active unchanged when no link has a Component', () => {
    const allNavOnly = [{ id: 'hide-panel' }, { id: 'agents' }];
    expect(resolveActivePanel('agents', allNavOnly)).toBe('agents');
  });
});

describe('resolveRouteActiveId', () => {
  const links = [
    { id: 'conversations' },
    { id: 'agents', path: '/agents/builder' },
    { id: 'information-management', path: '/information-management' },
    { id: 'files' },
  ];

  /** The regression: a full-page link could never show as selected, because
   *  panel state only ever tracks panels that render inside the sidebar. */
  it('selects the link whose page is open', () => {
    expect(resolveRouteActiveId(links, '/information-management')).toBe('information-management');
  });

  /** Agent Builder has sub-routes that are all the same destination. */
  it('matches a sub-route of a link’s page', () => {
    expect(resolveRouteActiveId(links, '/agents/builder/new')).toBe('agents');
    expect(resolveRouteActiveId(links, '/agents/builder/abc123')).toBe('agents');
  });

  it('selects nothing on a route no link owns', () => {
    expect(resolveRouteActiveId(links, '/c/new')).toBeUndefined();
  });

  it('ignores links that render a panel rather than a page', () => {
    expect(resolveRouteActiveId([{ id: 'conversations' }], '/conversations')).toBeUndefined();
  });

  /** A shorter path that happens to prefix a longer one must not shadow it,
   *  or the more general link would swallow the specific page. */
  it('prefers the most specific matching path', () => {
    const nested = [
      { id: 'broad', path: '/agents' },
      { id: 'builder', path: '/agents/builder' },
    ];

    expect(resolveRouteActiveId(nested, '/agents/builder/new')).toBe('builder');
    expect(resolveRouteActiveId(nested, '/agents/marketplace')).toBe('broad');
  });
});
