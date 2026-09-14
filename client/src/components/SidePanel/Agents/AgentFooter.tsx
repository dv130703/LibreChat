import { Globe } from 'lucide-react';
import { Spinner } from '@librechat/client';
import { useWatch, useFormContext } from 'react-hook-form';
import {
  SystemRoles,
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import type { AgentForm, AgentPanelProps } from '~/common';
import { useLocalize, useAuthContext, useHasAccess, useResourcePermissions } from '~/hooks';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import { useUpdateAgentMutation } from '~/data-provider';
import DuplicateAgent from './DuplicateAgent';
import AdminSettings from './AdminSettings';
import DeleteButton from './DeleteButton';

export default function AgentFooter({
  createMutation,
  updateMutation,
  setCurrentAgentId,
  isAvatarUploading = false,
}: Pick<AgentPanelProps, 'setCurrentAgentId' | 'createMutation'> & {
  updateMutation: ReturnType<typeof useUpdateAgentMutation>;
  isAvatarUploading?: boolean;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();

  const methods = useFormContext<AgentForm>();

  const { control } = methods;
  const agent = useWatch({ control, name: 'agent' });
  const agent_id = useWatch({ control, name: 'id' });
  const hasAccessToShareAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.SHARE,
  });
  const hasAccessToShareRemoteAgents = useHasAccess({
    permissionType: PermissionTypes.REMOTE_AGENTS,
    permission: Permissions.SHARE,
  });
  const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
    ResourceType.AGENT,
    agent?._id || '',
  );
  const { hasPermission: hasRemoteAgentPermission, isLoading: remotePermissionsLoading } =
    useResourcePermissions(ResourceType.REMOTE_AGENT, agent?._id || '');

  const canShareThisAgent = hasPermission(PermissionBits.SHARE);
  const canEditThisAgent = hasPermission(PermissionBits.EDIT);
  const canDeleteThisAgent = hasPermission(PermissionBits.DELETE);
  const canShareRemoteAgent = hasRemoteAgentPermission(PermissionBits.SHARE);
  const isSaving = createMutation.isLoading || updateMutation.isLoading || isAvatarUploading;
  const saveLabel = agent_id ? localize('com_ui_save') : localize('com_ui_create');
  const renderSaveButton = () => (
    <span className="t-icon-swap" data-state={isSaving ? 'b' : 'a'} aria-hidden={false}>
      <span className="t-icon" data-icon="a">
        {saveLabel}
      </span>
      <span className="t-icon" data-icon="b">
        <Spinner className="icon-md" aria-hidden="true" />
      </span>
    </span>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {user?.role === SystemRoles.ADMIN && <AdminSettings />}
      {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canDeleteThisAgent) &&
        !permissionsLoading && (
          <DeleteButton
            agent_id={agent_id}
            setCurrentAgentId={setCurrentAgentId}
            createMutation={createMutation}
          />
        )}
      {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canShareThisAgent) &&
        hasAccessToShareAgents &&
        !permissionsLoading && (
          <GenericGrantAccessDialog
            resourceDbId={agent?._id}
            resourceId={agent_id}
            resourceName={agent?.name ?? ''}
            resourceType={ResourceType.AGENT}
          />
        )}
      {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canShareRemoteAgent) &&
        hasAccessToShareRemoteAgents &&
        !remotePermissionsLoading &&
        agent?._id && (
          <GenericGrantAccessDialog
            resourceDbId={agent?._id}
            resourceId={agent_id}
            resourceName={agent?.name ?? ''}
            resourceType={ResourceType.REMOTE_AGENT}
          >
            <button
              type="button"
              className="btn btn-neutral border-token-border-light h-9 px-3"
              title={localize('com_ui_remote_access')}
            >
              <Globe className="h-4 w-4" aria-hidden="true" />
            </button>
          </GenericGrantAccessDialog>
        )}
      {(agent?.author === user?.id || user?.role === SystemRoles.ADMIN || canEditThisAgent) &&
        !permissionsLoading && <DuplicateAgent agent_id={agent_id} />}
      {/* Submit Button */}
      <button
        className="btn btn-primary focus:shadow-outline flex h-9 items-center justify-center px-4 py-2 font-semibold text-white hover:bg-green-600 focus:border-green-500"
        type="submit"
        disabled={isSaving}
        aria-busy={isSaving}
      >
        {renderSaveButton()}
      </button>
    </div>
  );
}
