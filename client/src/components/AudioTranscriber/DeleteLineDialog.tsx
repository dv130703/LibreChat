import { Trash2 } from 'lucide-react';
import { OGDialog, OGDialogTemplate, Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** The line a pending deletion targets, as it currently reads on screen. */
export interface PendingLineDeletion {
  lineIndex: number;
  speaker?: string;
  text: string;
}

/**
 * Confirms removing a transcript line.
 *
 * Deliberately quotes the line back rather than only asking "are you sure?":
 * the risk being guarded against is a misclick in a dense list of near-
 * identical rows, and a yes/no prompt does nothing about that - the reviewer
 * has no way to tell whether the row the menu opened on is the one they
 * meant. Showing the speaker and words makes a wrong target obvious before
 * it is confirmed rather than after.
 */
export default function DeleteLineDialog({
  pending,
  onOpenChange,
  onConfirm,
}: {
  pending: PendingLineDeletion | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const localize = useLocalize();

  return (
    <OGDialog open={pending != null} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_transcript_delete_line_title')}
        className="w-11/12 border border-solid border-border-medium bg-surface-tertiary sm:w-[28rem]"
        showCloseButton={false}
        showCancelButton={false}
        footerClassName="[&>*]:flex-1 [&>*]:justify-center"
        main={
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <p className="text-sm text-text-secondary">
                {localize('com_ui_transcript_delete_line_description')}
              </p>
            </div>
            <blockquote className="max-h-32 overflow-y-auto rounded-md border-l-2 border-border-heavy bg-surface-secondary px-3 py-2">
              {pending?.speaker != null && (
                <p className="text-xs font-medium text-text-secondary">{pending.speaker}</p>
              )}
              <p className="whitespace-pre-wrap break-words text-sm text-text-primary">
                {pending?.text?.trim().length
                  ? pending.text
                  : localize('com_ui_transcript_delete_line_empty')}
              </p>
            </blockquote>
          </div>
        }
        buttons={
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {localize('com_ui_cancel')}
          </Button>
        }
        selection={
          <Button variant="destructive" onClick={onConfirm}>
            {localize('com_ui_delete')}
          </Button>
        }
      />
    </OGDialog>
  );
}
