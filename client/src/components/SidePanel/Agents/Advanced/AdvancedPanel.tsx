import { useMemo, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { useToastContext } from '@librechat/client';
import { Check, Copy } from 'lucide-react';
import { AgentCapabilities } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { sectionLabelClass, groupHeadingClass } from './ui';
import { useAgentPanelContext } from '~/Providers';
import StatefulSessions from './StatefulSessions';
import OrchestrationHub from './OrchestrationHub';
import MaxAgentSteps from './MaxAgentSteps';
import { useLocalize } from '~/hooks';

export default function AdvancedPanel() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { watch } = useFormContext<AgentForm>();
  const currentAgentId = watch('id');
  const [copied, setCopied] = useState(false);

  const { agentsConfig } = useAgentPanelContext();
  const statefulSessionsEnabled = useMemo(
    () => agentsConfig?.capabilities.includes(AgentCapabilities.stateful_code_sessions) ?? false,
    [agentsConfig],
  );

  const handleCopyAgentId = async () => {
    if (!currentAgentId) return;
    try {
      await navigator.clipboard.writeText(currentAgentId);
      setCopied(true);
      showToast({ message: localize('com_ui_agent_id_copied'), status: 'success' });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast({ message: localize('com_ui_error'), status: 'error' });
    }
  };

  return (
    <div className="mb-1 flex w-full flex-col gap-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text-primary">
          {localize('com_ui_advanced_settings')}
        </h2>
        {currentAgentId && (
          <div className="flex items-center gap-2">
            <span className={sectionLabelClass}>{localize('com_ui_agent_id')}</span>
            <button
              type="button"
              onClick={handleCopyAgentId}
              title={currentAgentId}
              aria-label={localize('com_ui_agent_id_copy')}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            >
              <code className="max-w-[150px] truncate font-mono text-xs">{currentAgentId}</code>
              <span className="t-icon-swap" data-state={copied ? 'b' : 'a'} aria-hidden="true">
                <span className="t-icon" data-icon="a">
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="t-icon" data-icon="b">
                  <Check className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
                </span>
              </span>
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-8 gap-y-5 px-2 pb-2 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <span className={groupHeadingClass}>{localize('com_ui_essentials')}</span>
          <MaxAgentSteps />
          {statefulSessionsEnabled && <StatefulSessions />}
        </section>

        <OrchestrationHub currentAgentId={currentAgentId} />
      </div>
    </div>
  );
}
