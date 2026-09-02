/** Shared between the Audio Transcriber's pre-export form (client) and the
 *  interview .docx builder (server) - see `packages/api/src/transcription/interviewDocx.ts`.
 *  Both need identical answers to "who's present, in what order, numbered
 *  how, formatted how" - duplicating this would risk the document silently
 *  drifting from what the form showed the user before they clicked Export.
 */

/** The minimal shape this module reads from a speaker - deliberately not the
 *  client's own `SpeakerOption` (which also carries a `dotColorClass` this
 *  logic has no use for), so the server side has no UI type to satisfy. */
export interface NamedSpeaker {
  id: string;
  name: string;
}

/** Everything the pre-export form collects. `date` is the raw
 *  `<input type="date">` value (`YYYY-MM-DD`) - kept as the string the input
 *  gave rather than a `Date`, so formatting never runs through a timezone
 *  conversion that could roll the day forward or back. `commenced`/`completed`
 *  are bare 4-digit 24-hour time (`HHMM`, no colon, no am/pm) - what the
 *  template's "[Time] Hours" slot takes literally. */
export interface InterviewTranscriptForm {
  caseName: string;
  /** Printed directly under the witness name on the cover sheet, e.g.
   *  "Voluntary", "Under Caution", "Compulsory (Section 2)" - previously
   *  hardcoded to "Voluntary" for every export; now the reviewer's own call,
   *  since not every recorded interview actually was voluntary. */
  interviewType: string;
  location: string;
  date: string;
  commenced: string;
  completed: string;
  /** Speaker ids marked as witnesses, in selection order - the order they
   *  were checked in the People step, which is also Present-list order. */
  witnessIds: string[];
  /** Free-text role, required for every speaker id not in `witnessIds`. */
  roles: Record<string, string>;
  /** Optional per-speaker surname, used to label their turns in the exported
   *  transcript body (uppercased - "SMITH", not "Jane Smith"). Every speaker
   *  can supply one, witnesses included, since a witness's own dialogue gets
   *  the same uppercase-surname label as everyone else's. A speaker with
   *  nothing here falls back to their full display name uppercased. */
  lastNames: Record<string, string>;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `YYYY-MM-DD` -> `D Month YYYY` (no leading zero on the day), e.g.
 *  `2026-07-01` -> `1 July 2026`. Parses the string's own components rather
 *  than constructing a `Date` and reading it back, so no timezone conversion
 *  can shift the day - `<input type="date">` already hands over exactly the
 *  calendar date the user picked. */
export function formatInterviewDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const monthName = MONTH_NAMES[month - 1] ?? '';
  return `${day} ${monthName} ${year}`;
}

/** `HH:MM` (what `<input type="time">` always returns - zero-padded 24-hour,
 *  regardless of locale) -> bare `HHMM`. */
export function toBareTime(inputTimeValue: string): string {
  return inputTimeValue.replace(':', '');
}

/** "A" / "A and B" / "A, B and C" - the conventional list join for a document
 *  subtitle naming multiple people. */
export function joinNames(names: string[]): string {
  if (names.length === 0) {
    return '';
  }
  if (names.length === 1) {
    return names[0];
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface InterviewFormErrors {
  caseName?: string;
  interviewType?: string;
  location?: string;
  date?: string;
  commenced?: string;
  completed?: string;
  witnesses?: string;
  roles?: Record<string, string>;
}

/** Every rule from the spec in one place, so the dialog can show all
 *  violations at once on submit rather than one at a time. */
export function validateInterviewForm(
  form: InterviewTranscriptForm,
  speakerOptions: NamedSpeaker[],
): InterviewFormErrors {
  const errors: InterviewFormErrors = {};

  if (form.caseName.trim() === '') {
    errors.caseName = 'com_ui_interview_error_required';
  }
  if (form.interviewType.trim() === '') {
    errors.interviewType = 'com_ui_interview_error_required';
  }
  if (form.location.trim() === '') {
    errors.location = 'com_ui_interview_error_required';
  }
  if (form.date === '') {
    errors.date = 'com_ui_interview_error_required';
  }
  if (form.commenced === '') {
    errors.commenced = 'com_ui_interview_error_required';
  }
  if (form.completed === '') {
    errors.completed = 'com_ui_interview_error_required';
  } else if (form.commenced !== '' && form.completed <= form.commenced) {
    errors.completed = 'com_ui_interview_error_time_order';
  }
  if (form.witnessIds.length === 0) {
    errors.witnesses = 'com_ui_interview_error_witness_required';
  }

  const witnessSet = new Set(form.witnessIds);
  const roleErrors: Record<string, string> = {};
  for (const option of speakerOptions) {
    if (!witnessSet.has(option.id) && (form.roles[option.id] ?? '').trim() === '') {
      roleErrors[option.id] = 'com_ui_interview_error_required';
    }
  }
  if (Object.keys(roleErrors).length > 0) {
    errors.roles = roleErrors;
  }

  return errors;
}

export function hasInterviewFormErrors(errors: InterviewFormErrors): boolean {
  return (
    errors.caseName != null ||
    errors.interviewType != null ||
    errors.location != null ||
    errors.date != null ||
    errors.commenced != null ||
    errors.completed != null ||
    errors.witnesses != null ||
    (errors.roles != null && Object.keys(errors.roles).length > 0)
  );
}
