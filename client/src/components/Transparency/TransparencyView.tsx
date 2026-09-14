import { useState } from 'react';
import { ArrowLeft, Wrench, Shield, Waypoints, Users } from 'lucide-react';
import { useParams, useNavigate } from 'react-router-dom';
import type { TMessageTransparencyToolCall } from 'librechat-data-provider';
import { useGetMessageTransparencyQuery } from '~/data-provider';
import AgentBuilderCard from '~/components/Agents/layouts/AgentBuilderCard';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { SidePanelGroup } from '~/components/SidePanel';
import { useLocalize, useDocumentTitle } from '~/hooks';
import { cn } from '~/utils';

function formatArgs(args: string | Record<string, unknown> | undefined): string {
  if (args == null) {
    return '';
  }
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

function ToolCallCard({ toolCall }: { toolCall: TMessageTransparencyToolCall }) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border-light">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Wrench className="h-4 w-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
          <code className="truncate text-sm font-medium text-text-primary">{toolCall.name}</code>
          {toolCall.isHandoff && (
            <span className="flex-shrink-0 rounded-full bg-surface-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
              {localize('com_transparency_handoff_badge')}
            </span>
          )}
          {toolCall.isSubagent && (
            <span className="flex-shrink-0 rounded-full bg-surface-tertiary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
              {localize('com_transparency_subagent_badge')}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border-light px-3 py-3">
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              {localize('com_transparency_args_label')}
            </span>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary p-2 text-xs text-text-primary">
              {formatArgs(toolCall.args) || localize('com_transparency_empty_value')}
            </pre>
          </div>
          <div>
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              {localize('com_transparency_output_label')}
            </span>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary p-2 text-xs text-text-primary">
              {toolCall.output || localize('com_transparency_empty_value')}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TransparencyView() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { conversationId, messageId } = useParams<{
    conversationId: string;
    messageId: string;
  }>();

  useDocumentTitle(`${localize('com_transparency_title')} | LibreChat`);

  const { data, isLoading, isError } = useGetMessageTransparencyQuery(
    conversationId ?? '',
    messageId ?? '',
  );

  return (
    <div className="relative flex w-full grow overflow-hidden bg-presentation">
      <SidePanelGroup>
        <main className="flex h-full flex-col overflow-hidden" role="main">
          <div className="scrollbar-gutter-stable mx-auto flex h-full w-full max-w-4xl flex-col gap-5 overflow-y-auto px-4 py-6 lg:px-6">
            <div className="flex items-center gap-2 md:hidden">
              <OpenSidebar />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => navigate(conversationId ? `/c/${conversationId}` : '/c/new')}
                aria-label={localize('com_transparency_back_to_conversation')}
                className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border-light text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <h1 className="text-lg font-semibold text-text-primary">
                {localize('com_transparency_title')}
              </h1>
            </div>

            {isLoading && (
              <p className="text-sm text-text-secondary">{localize('com_transparency_loading')}</p>
            )}
            {isError && (
              <p className="text-sm text-red-500">{localize('com_transparency_error')}</p>
            )}

            {data && (
              <>
                <AgentBuilderCard>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                        {localize('com_transparency_created_at')}
                      </span>
                      <span className="text-sm text-text-primary">
                        {new Date(data.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                        {localize('com_transparency_endpoint')}
                      </span>
                      <span className="text-sm text-text-primary">{data.endpoint ?? '—'}</span>
                    </div>
                  </div>
                </AgentBuilderCard>

                {data.agent ? (
                  <AgentBuilderCard id="section-transparency-agent">
                    <div className="mb-3 flex items-center gap-2">
                      <Shield className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                        {localize('com_transparency_agent_section')}
                      </span>
                    </div>
                    <p
                      className={cn(
                        'mb-3 rounded-lg px-3 py-2 text-xs',
                        data.agent.source === 'reconstructed'
                          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                          : 'bg-surface-secondary text-text-secondary',
                      )}
                    >
                      {data.agent.source === 'reconstructed'
                        ? localize('com_transparency_agent_reconstructed', {
                            0: data.agent.versionUpdatedAt
                              ? new Date(data.agent.versionUpdatedAt).toLocaleString()
                              : '',
                          })
                        : localize('com_transparency_agent_current')}
                    </p>
                    <div className="flex flex-col gap-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                            {localize('com_ui_model')}
                          </span>
                          <span className="text-sm text-text-primary">
                            {data.agent.model ?? '—'}
                          </span>
                        </div>
                        <div>
                          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                            {localize('com_ui_provider')}
                          </span>
                          <span className="text-sm text-text-primary">
                            {data.agent.provider ?? '—'}
                          </span>
                        </div>
                      </div>
                      <div>
                        <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                          {localize('com_transparency_instructions_label')}
                        </span>
                        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-secondary p-2 text-xs text-text-primary">
                          {data.agent.instructions || localize('com_transparency_empty_value')}
                        </pre>
                      </div>
                      {data.agent.tools.length > 0 && (
                        <div>
                          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                            {localize('com_transparency_tools_available_label')}
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {data.agent.tools.map((tool) => (
                              <span
                                key={tool}
                                className="rounded-full bg-surface-tertiary px-2 py-0.5 text-xs text-text-secondary"
                              >
                                {tool}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </AgentBuilderCard>
                ) : (
                  data.endpoint === 'agents' && (
                    <AgentBuilderCard>
                      <p className="text-sm text-text-secondary">
                        {localize('com_transparency_agent_deleted')}
                      </p>
                    </AgentBuilderCard>
                  )
                )}

                <AgentBuilderCard id="section-transparency-tools">
                  <div className="mb-3 flex items-center gap-2">
                    <Waypoints className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                    <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
                      {localize('com_transparency_tools_section')}
                    </span>
                  </div>
                  {data.toolCalls.length === 0 ? (
                    <p className="text-sm text-text-secondary">
                      {localize('com_transparency_no_tool_calls')}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {data.toolCalls.map((toolCall, index) => (
                        <ToolCallCard key={toolCall.id ?? index} toolCall={toolCall} />
                      ))}
                    </div>
                  )}
                </AgentBuilderCard>

                {!data.agent && data.endpoint !== 'agents' && (
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    {localize('com_transparency_no_agent', {
                      0: data.model ?? '',
                      1: data.endpoint ?? '',
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </SidePanelGroup>
    </div>
  );
}
