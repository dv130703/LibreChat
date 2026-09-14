import { Bot, SlidersHorizontal, Waypoints, History } from 'lucide-react';
import { useAgentPanelContext } from '~/Providers';
import { Panel, isEphemeralAgent } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const TAB_CLASS =
  'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary';

/** Top-level tab bar for the full-page Agent Builder, replacing the narrow
 * side panel's chevron-back sub-page navigation between Builder/Model/Advanced/Version. */
export default function AgentBuilderTabs() {
  const localize = useLocalize();
  const { activePanel, setActivePanel, agent_id } = useAgentPanelContext();
  const hasAgent = !isEphemeralAgent(agent_id);

  const tabs: Array<{ id: Panel; label: string; icon: React.ReactNode }> = [
    {
      id: Panel.builder,
      label: localize('com_sidepanel_agent_builder'),
      icon: <Bot className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
    },
    {
      id: Panel.model,
      label: localize('com_ui_model'),
      icon: <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
    },
    {
      id: Panel.advanced,
      label: localize('com_ui_advanced'),
      icon: <Waypoints className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
    },
  ];

  if (hasAgent) {
    tabs.push({
      id: Panel.version,
      label: localize('com_ui_agent_version'),
      icon: <History className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
    });
  }

  return (
    <div
      className="flex gap-1 overflow-x-auto border-b border-border-light"
      role="tablist"
      aria-label={localize('com_sidepanel_agent_builder')}
    >
      {tabs.map((tab) => {
        const isActive = activePanel === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => setActivePanel(tab.id)}
            className={cn(
              TAB_CLASS,
              isActive
                ? 'border-text-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
