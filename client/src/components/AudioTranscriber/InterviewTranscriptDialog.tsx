import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { Users } from 'lucide-react';
import { OGDialog, OGDialogTemplate, Checkbox, Input, Label, Button } from '@librechat/client';
import { useLocalize } from '~/hooks';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { cn } from '~/utils';
import { validateInterviewForm, hasInterviewFormErrors, toBareTime } from 'librechat-data-provider';
import type { InterviewTranscriptForm, InterviewFormErrors } from 'librechat-data-provider';
import type { SpeakerOption } from './types';

const EMPTY_FORM: InterviewTranscriptForm = {
  caseName: '',
  // Pre-filled since it's the common case, but still an editable field, not
  // a hardcoded document constant - not every recorded interview is one.
  interviewType: 'Voluntary',
  location: '',
  date: '',
  commenced: '',
  completed: '',
  witnessIds: [],
  roles: {},
  lastNames: {},
};

/** True once `errors` has anything from the People step (step 1): witness
 *  selection and per-speaker roles. Kept separate from the Details errors so
 *  "Next" can block on this step's own mistakes instead of letting them
 *  surface two steps later at Export - closer to where they were made is
 *  closer to when they're still cheap to fix. */
function hasPeopleErrors(errors: InterviewFormErrors): boolean {
  return errors.witnesses != null || (errors.roles != null && Object.keys(errors.roles).length > 0);
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

/** Two dots, filled left-to-right as the user advances - the same "where am
 *  I" signal a numbered stepper gives, at a fraction of the visual weight.
 *  Reused as-is wherever this dialog's step count doesn't change, which is
 *  why it takes a bare `step` rather than a generic label list. */
function StepDots({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      <span
        className={cn(
          'h-1.5 w-5 rounded-full transition-colors',
          step >= 1 ? 'bg-blue-500 dark:bg-blue-400' : 'bg-surface-tertiary',
        )}
      />
      <span
        className={cn(
          'h-1.5 w-5 rounded-full transition-colors',
          step >= 2 ? 'bg-blue-500 dark:bg-blue-400' : 'bg-surface-tertiary',
        )}
      />
    </div>
  );
}

/**
 * A single labelled field within a speaker's card - the pattern every field
 * below (surname, role) shares: a persistent caption above a full-width
 * input, `min-w-0` on both the field and its grid cell so a native
 * `<input type="date">`/`<input type="time">` elsewhere in this dialog can
 * never force a row wider than the card that holds it.
 */
function MiniField({
  id,
  label,
  value,
  placeholder,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <div className="min-w-0">
      <Label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error != null}
        className="mt-1 h-8 w-full min-w-0 text-sm"
      />
      <FieldError messageKey={error} />
    </div>
  );
}

/**
 * One speaker, one card. The checkbox comes FIRST in the row and is the only
 * fixed-width sibling before the name - nothing can push it past the edge of
 * the card, unlike a trailing control competing for space against a
 * variable-length name. Checked state is never color-only either: a real
 * checkmark glyph fills the box, and a small "Witness" badge appears next to
 * the name only when checked - unchecked rows carry no witness text at all,
 * so the word "Witness" is never printed next to someone who isn't one.
 *
 * The name is never anything but a fixed, bold, non-interactive label -
 * clicking the row (not just the checkbox itself) toggles witness state,
 * mirroring `ToggleRow`'s click-forwarding in `TranscribeOptionsDialog`, so
 * the hit target is the whole row, not a 16px box.
 *
 * Below that, every speaker gets a Last name field (their turns in the
 * exported dialogue are labelled by it, uppercased - falls back to their
 * full name if left blank), and a non-witness additionally gets a Role
 * field, captioned and visually distinct from Last name so the two are never
 * confused for one another. Order matches the exported Present list, so
 * what's on screen here previews what the document will actually say.
 */
function SpeakerCard({
  option,
  isWitness,
  role,
  lastName,
  roleError,
  onToggleWitness,
  onRoleChange,
  onLastNameChange,
}: {
  option: SpeakerOption;
  isWitness: boolean;
  role: string;
  lastName: string;
  roleError?: string;
  onToggleWitness: (checked: boolean) => void;
  onRoleChange: (value: string) => void;
  onLastNameChange: (value: string) => void;
}) {
  const localize = useLocalize();

  const handleRowClick = (event: MouseEvent) => {
    // The checkbox already toggles itself and its click would otherwise
    // bubble here and toggle a second time, canceling out - only clicks on
    // the rest of the row (the name, the empty space beside it) should
    // trigger this handler.
    if ((event.target as HTMLElement).closest('button[role="checkbox"]')) {
      return;
    }
    onToggleWitness(!isWitness);
  };

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        isWitness
          ? 'border-blue-500/40 bg-blue-500/5 dark:border-blue-400/30'
          : 'border-border-light bg-surface-primary',
      )}
    >
      <div
        role="presentation"
        onClick={handleRowClick}
        className="flex cursor-pointer items-start gap-3"
      >
        <Checkbox
          id={`interview-witness-${option.id}`}
          aria-label={localize('com_ui_interview_witness_toggle_label', { 0: option.name })}
          checked={isWitness}
          onCheckedChange={(checked) => onToggleWitness(checked === true)}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn('h-2.5 w-2.5 shrink-0 rounded-full', option.dotColorClass)}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              {option.name}
            </span>
            {isWitness && (
              <span className="shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-400/15 dark:text-blue-300">
                {localize('com_ui_interview_witness_badge')}
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        className={cn(
          'mt-2.5 grid gap-2.5 pl-7',
          isWitness ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2',
        )}
      >
        <MiniField
          id={`interview-lastname-${option.id}`}
          label={localize('com_ui_interview_lastname_label')}
          value={lastName}
          placeholder={localize('com_ui_interview_lastname_placeholder')}
          onChange={onLastNameChange}
        />
        {!isWitness && (
          <MiniField
            id={`interview-role-${option.id}`}
            label={localize('com_ui_interview_role_caption')}
            value={role}
            placeholder={localize('com_ui_interview_role_placeholder')}
            onChange={onRoleChange}
            error={roleError}
          />
        )}
      </div>
    </div>
  );
}

interface InterviewTranscriptDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  speakerOptions: SpeakerOption[];
  onConfirm: (form: InterviewTranscriptForm) => void;
}

/** Pre-export form for the "Interview transcript" format, in two steps: who
 *  was present (step 1, built from the transcript's own speaker list - the
 *  assignment already exists, this form only asks which of them is a
 *  witness and what surname labels their dialogue), then the case paperwork
 *  (step 2). Splitting it this way keeps each screen to one kind of decision
 *  instead of several fighting for attention at once, and nothing is
 *  defaulted or guessed silently: a header this formal is wrong in a way
 *  plain text never is. */
export default function InterviewTranscriptDialog({
  isOpen,
  onOpenChange,
  speakerOptions,
  onConfirm,
}: InterviewTranscriptDialogProps) {
  const localize = useLocalize();
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<InterviewTranscriptForm>(EMPTY_FORM);
  const [step1Attempted, setStep1Attempted] = useState(false);
  const [step2Attempted, setStep2Attempted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setForm(EMPTY_FORM);
      setStep1Attempted(false);
      setStep2Attempted(false);
    }
  }, [isOpen]);

  const errors: InterviewFormErrors = validateInterviewForm(form, speakerOptions);

  const setField = <K extends keyof InterviewTranscriptForm>(
    key: K,
    value: InterviewTranscriptForm[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const toggleWitness = (speakerId: string, checked: boolean) => {
    setForm((current) => {
      const witnessIds = checked
        ? [...current.witnessIds, speakerId]
        : current.witnessIds.filter((id) => id !== speakerId);
      // A speaker just marked a witness carries no role - drop it rather than
      // leave a stale value someone unchecks them and now can't explain.
      const roles = { ...current.roles };
      if (checked) {
        delete roles[speakerId];
      }
      return { ...current, witnessIds, roles };
    });
  };

  const setRole = (speakerId: string, role: string) => {
    setForm((current) => ({ ...current, roles: { ...current.roles, [speakerId]: role } }));
  };

  const setLastName = (speakerId: string, lastName: string) => {
    setForm((current) => ({
      ...current,
      lastNames: { ...current.lastNames, [speakerId]: lastName },
    }));
  };

  const handleNext = () => {
    setStep1Attempted(true);
    if (!hasPeopleErrors(errors)) {
      setStep(2);
    }
  };

  const handleExport = () => {
    setStep2Attempted(true);
    if (!hasInterviewFormErrors(errors)) {
      onConfirm(form);
      onOpenChange(false);
    }
  };

  return (
    <OGDialog open={isOpen} onOpenChange={onOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_interview_dialog_title')}
        description={localize(
          step === 1
            ? 'com_ui_interview_step_people_description'
            : 'com_ui_interview_step_details_description',
        )}
        className="w-11/12 sm:w-[36rem]"
        showCloseButton
        showCancelButton={false}
        main={
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-0.5">
              <StepDots step={step} />
              <span className="text-xs font-medium text-text-tertiary">
                {localize('com_ui_interview_step_of', { 0: String(step) })}
              </span>
            </div>

            {step === 1 ? (
              <div
                key="step-1"
                className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto motion-safe:duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
              >
                {speakerOptions.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-medium py-8 text-center">
                    <Users className="h-5 w-5 text-text-tertiary" aria-hidden="true" />
                    <p className="text-sm text-text-secondary">
                      {localize('com_ui_interview_no_speakers')}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {speakerOptions.map((option) => (
                      <SpeakerCard
                        key={option.id}
                        option={option}
                        isWitness={form.witnessIds.includes(option.id)}
                        role={form.roles[option.id] ?? ''}
                        lastName={form.lastNames[option.id] ?? ''}
                        roleError={step1Attempted ? errors.roles?.[option.id] : undefined}
                        onToggleWitness={(checked) => toggleWitness(option.id, checked)}
                        onRoleChange={(value) => setRole(option.id, value)}
                        onLastNameChange={(value) => setLastName(option.id, value)}
                      />
                    ))}
                  </div>
                )}
                {step1Attempted && <FieldError messageKey={errors.witnesses} />}
              </div>
            ) : (
              <div
                key="step-2"
                className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1 motion-safe:duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
              >
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor="interview-case-name" className="text-sm font-medium">
                    {localize('com_ui_interview_case_name_label')}
                  </Label>
                  <Input
                    id="interview-case-name"
                    value={form.caseName}
                    onChange={(e) => setField('caseName', e.target.value)}
                    aria-invalid={step2Attempted && errors.caseName != null}
                    className="w-full min-w-0"
                  />
                  {step2Attempted && <FieldError messageKey={errors.caseName} />}
                </div>

                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor="interview-type" className="text-sm font-medium">
                    {localize('com_ui_interview_type_label')}
                  </Label>
                  <Input
                    id="interview-type"
                    value={form.interviewType}
                    onChange={(e) => setField('interviewType', e.target.value)}
                    placeholder={localize('com_ui_interview_type_placeholder')}
                    aria-invalid={step2Attempted && errors.interviewType != null}
                    className="w-full min-w-0"
                  />
                  {step2Attempted && <FieldError messageKey={errors.interviewType} />}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor="interview-date" className="text-sm font-medium">
                      {localize('com_ui_interview_date_label')}
                    </Label>
                    <Input
                      id="interview-date"
                      type="date"
                      value={form.date}
                      onChange={(e) => setField('date', e.target.value)}
                      aria-invalid={step2Attempted && errors.date != null}
                      className="w-full min-w-0 dark:[color-scheme:dark]"
                    />
                    {step2Attempted && <FieldError messageKey={errors.date} />}
                  </div>
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor="interview-location" className="text-sm font-medium">
                      {localize('com_ui_interview_location_label')}
                    </Label>
                    <Input
                      id="interview-location"
                      value={form.location}
                      onChange={(e) => setField('location', e.target.value)}
                      aria-invalid={step2Attempted && errors.location != null}
                      className="w-full min-w-0"
                    />
                    {step2Attempted && <FieldError messageKey={errors.location} />}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor="interview-commenced" className="text-sm font-medium">
                      {localize('com_ui_interview_commenced_label')}
                    </Label>
                    <Input
                      id="interview-commenced"
                      type="time"
                      value={
                        form.commenced === ''
                          ? ''
                          : `${form.commenced.slice(0, 2)}:${form.commenced.slice(2)}`
                      }
                      onChange={(e) => setField('commenced', toBareTime(e.target.value))}
                      aria-invalid={step2Attempted && errors.commenced != null}
                      className="w-full min-w-0 dark:[color-scheme:dark]"
                    />
                    {step2Attempted && <FieldError messageKey={errors.commenced} />}
                  </div>
                  <div className="grid min-w-0 gap-1.5">
                    <Label htmlFor="interview-completed" className="text-sm font-medium">
                      {localize('com_ui_interview_completed_label')}
                    </Label>
                    <Input
                      id="interview-completed"
                      type="time"
                      value={
                        form.completed === ''
                          ? ''
                          : `${form.completed.slice(0, 2)}:${form.completed.slice(2)}`
                      }
                      onChange={(e) => setField('completed', toBareTime(e.target.value))}
                      aria-invalid={step2Attempted && errors.completed != null}
                      className="w-full min-w-0 dark:[color-scheme:dark]"
                    />
                    {step2Attempted && <FieldError messageKey={errors.completed} />}
                  </div>
                </div>
              </div>
            )}
          </div>
        }
        leftButtons={
          step === 2 ? (
            <Button variant="outline" onClick={() => setStep(1)}>
              {localize('com_ui_back')}
            </Button>
          ) : undefined
        }
        buttons={
          step === 1 ? (
            <Button variant="submit" onClick={handleNext}>
              {localize('com_ui_next')}
            </Button>
          ) : undefined
        }
        selection={
          step === 2
            ? {
                selectHandler: handleExport,
                selectText: localize('com_ui_interview_export_button'),
              }
            : undefined
        }
      />
    </OGDialog>
  );
}
