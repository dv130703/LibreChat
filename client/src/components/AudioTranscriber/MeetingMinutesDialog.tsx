import { useEffect, useState } from 'react';
import { OGDialog, OGDialogTemplate, Input, Label } from '@librechat/client';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { validateMeetingMinutesForm, hasMeetingMinutesFormErrors } from 'librechat-data-provider';
import type { MeetingMinutesForm, MeetingMinutesFormErrors } from 'librechat-data-provider';

/** `Date` -> `YYYY-MM-DD` in the viewer's own local calendar day, matching
 *  what `<input type="date">` itself would produce if the user picked
 *  "today" by hand - never `toISOString()`, which reads UTC and can land on
 *  the wrong day depending on timezone and time of day. */
function todayAsInputValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function FieldError({ messageKey }: { messageKey?: string }) {
  const localize = useLocalize();
  if (messageKey == null) {
    return null;
  }
  return (
    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
      {localize(messageKey as TranslationKeys)}
    </p>
  );
}

interface MeetingMinutesDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The conversation's own title, prefilled as a starting point - a
   *  generic "New Chat" title is still better edited than typed from
   *  scratch. */
  initialTitle: string;
  onConfirm: (form: MeetingMinutesForm) => void;
}

/**
 * Pre-export form for the "Meeting minutes" format - just enough to head
 * the document, nothing this format doesn't need. Unlike the interview
 * export, there's no witness/role/case-paperwork step: attendees are every
 * named speaker in the transcript, listed automatically, so this is a
 * single screen rather than a wizard.
 */
export default function MeetingMinutesDialog({
  isOpen,
  onOpenChange,
  initialTitle,
  onConfirm,
}: MeetingMinutesDialogProps) {
  const localize = useLocalize();
  const [form, setForm] = useState<MeetingMinutesForm>({ title: '', date: '' });
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setForm({ title: initialTitle, date: todayAsInputValue() });
      setAttempted(false);
    }
  }, [isOpen, initialTitle]);

  const errors: MeetingMinutesFormErrors = validateMeetingMinutesForm(form);

  const handleExport = () => {
    setAttempted(true);
    if (!hasMeetingMinutesFormErrors(errors)) {
      onConfirm(form);
      onOpenChange(false);
    }
  };

  return (
    <OGDialog open={isOpen} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_meeting_minutes_dialog_title')}
        description={localize('com_ui_meeting_minutes_dialog_description')}
        className="w-11/12 sm:w-[26rem]"
        showCloseButton
        showCancelButton={false}
        main={
          <div className="flex flex-col gap-4">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="meeting-minutes-title" className="text-sm font-medium">
                {localize('com_ui_meeting_minutes_title_label')}
              </Label>
              <Input
                id="meeting-minutes-title"
                value={form.title}
                onChange={(e) => setForm((current) => ({ ...current, title: e.target.value }))}
                aria-invalid={attempted && errors.title != null}
                className="w-full min-w-0"
              />
              {attempted && <FieldError messageKey={errors.title} />}
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="meeting-minutes-date" className="text-sm font-medium">
                {localize('com_ui_meeting_minutes_date_label')}
              </Label>
              <Input
                id="meeting-minutes-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm((current) => ({ ...current, date: e.target.value }))}
                aria-invalid={attempted && errors.date != null}
                className="w-full min-w-0 dark:[color-scheme:dark]"
              />
              {attempted && <FieldError messageKey={errors.date} />}
            </div>
          </div>
        }
        selection={{
          selectHandler: handleExport,
          selectText: localize('com_ui_meeting_minutes_export_button'),
        }}
      />
    </OGDialog>
  );
}
