import React, { memo } from 'react';
import { useRecoilValue } from 'recoil';
import { CheckboxButton, VectorIcon } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useLocalize, useHasAccess } from '~/hooks';
import { useBadgeRowContext } from '~/Providers';
import { isAudioTranscriberConvo } from '~/store';

function FileSearch() {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const { toggleState: fileSearchEnabled, debouncedChange, isPinned } = context?.fileSearch ?? {};
  /** Audio Transcriber forces file_search on for its own conversations so the
   *  model can retrieve the RAG-embedded transcript - that's an implementation
   *  detail, not a user choice, so the toggle stays hidden there. */
  const isTranscriberConvo = useRecoilValue(isAudioTranscriberConvo(context?.conversationId ?? ''));

  const canUseFileSearch = useHasAccess({
    permissionType: PermissionTypes.FILE_SEARCH,
    permission: Permissions.USE,
  });

  if (!canUseFileSearch || isTranscriberConvo) {
    return null;
  }

  return (
    <>
      {(fileSearchEnabled || isPinned) && (
        <CheckboxButton
          className="max-w-fit"
          checked={fileSearchEnabled}
          setValue={debouncedChange}
          label={localize('com_assistants_file_search')}
          isCheckedClassName="border-green-600/40 bg-green-500/10 hover:bg-green-700/10"
          icon={<VectorIcon className="icon-md" />}
        />
      )}
    </>
  );
}

export default memo(FileSearch);
