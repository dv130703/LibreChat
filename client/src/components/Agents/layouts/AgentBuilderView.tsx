import { useCallback } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useDocumentTitle, useHasAccess, useGetAgentsConfig, useLocalize } from '~/hooks';
import { useGetEndpointsQuery } from '~/data-provider';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { AgentPanelProvider } from '~/Providers/AgentPanelContext';
import { MarketplaceProvider } from '../MarketplaceContext';
import { SidePanelGroup } from '~/components/SidePanel';
import AgentPanel from '~/components/SidePanel/Agents/AgentPanel';

/** Full-page route for the Agent Builder (`/agents/builder/new`, `/agents/builder/:agentId`),
 * replacing the side-panel builder. The URL is the source of truth for which agent is
 * being edited, bridged into `AgentPanelProvider` in place of the side panel's Recoil
 * "sync to the current conversation's agent" convenience. */
export default function AgentBuilderView() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { agentId: rawAgentId } = useParams<{ agentId: string }>();
  const resolvedAgentId = rawAgentId && rawAgentId !== 'new' ? rawAgentId : undefined;

  const { isLoading: endpointsLoading } = useGetEndpointsQuery();
  const { agentsConfig } = useGetAgentsConfig();
  const hasAccessToAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const hasAccessToCreateAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.CREATE,
  });

  useDocumentTitle(`${localize('com_sidepanel_agent_builder')} | LibreChat`);

  const handleAgentIdChange = useCallback(
    (agentId: string | undefined) => {
      navigate(`/agents/builder/${agentId ?? 'new'}`, { replace: true });
    },
    [navigate],
  );

  if (endpointsLoading) {
    return null;
  }

  const canAccessBuilder =
    agentsConfig != null &&
    hasAccessToAgents &&
    hasAccessToCreateAgents &&
    agentsConfig.disableBuilder !== true;

  if (!canAccessBuilder) {
    return <Navigate to="/c/new" replace={true} />;
  }

  return (
    <div className="relative flex w-full grow overflow-hidden bg-presentation">
      <SidePanelGroup>
        <main className="flex h-full flex-col overflow-hidden" role="main">
          <div className="scrollbar-gutter-stable flex h-full flex-col overflow-y-auto overflow-x-hidden">
            <div className="flex items-center gap-2 px-4 pt-3 md:hidden">
              <OpenSidebar />
            </div>
            {/* MarketplaceProvider supplies ChatContext: the sidebar's own ChatContext
             * (UnifiedSidebar's SidebarChatProvider) only wraps the side panel, not the
             * <Outlet/> content area this route renders into — the model parameter
             * inputs (DynamicSlider et al.) call useChatContext() unconditionally. */}
            <MarketplaceProvider>
              <AgentPanelProvider agentId={resolvedAgentId} onAgentIdChange={handleAgentIdChange}>
                <AgentPanel />
              </AgentPanelProvider>
            </MarketplaceProvider>
          </div>
        </main>
      </SidePanelGroup>
    </div>
  );
}
