/** Shared between the Audio Transcriber's Meeting Minutes pre-export form
 *  (client) and the .docx builder (server) - see
 *  `packages/api/src/transcription/meetingMinutesDocx.ts`. Deliberately much
 *  smaller than `InterviewTranscriptForm`: this format has no witnesses, no
 *  roles, no case name, no per-speaker surname labelling - just a title, a
 *  date, and whoever spoke gets listed as an attendee automatically. */

export interface MeetingMinutesForm {
  /** Defaults to the conversation's own title, but editable - a conversation
   *  titled "New Chat" or similar shouldn't have to become the document's
   *  own heading. */
  title: string;
  /** Same raw `<input type="date">` value (`YYYY-MM-DD`) `InterviewTranscriptForm`
   *  uses, for the same reason: no timezone conversion between what the user
   *  picked and what gets printed. */
  date: string;
}

export interface MeetingMinutesFormErrors {
  title?: string;
  date?: string;
}

export function validateMeetingMinutesForm(form: MeetingMinutesForm): MeetingMinutesFormErrors {
  const errors: MeetingMinutesFormErrors = {};
  if (form.title.trim() === '') {
    errors.title = 'com_ui_meeting_minutes_error_required';
  }
  if (form.date === '') {
    errors.date = 'com_ui_meeting_minutes_error_required';
  }
  return errors;
}

export function hasMeetingMinutesFormErrors(errors: MeetingMinutesFormErrors): boolean {
  return errors.title != null || errors.date != null;
}
