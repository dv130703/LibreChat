import type * as t from './types';
import { EndpointURLs } from './config';
import * as s from './schemas';

/** Resolves the browser's IANA timezone so the server can localize prompt variables. */
function getUserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export default function createPayload(submission: t.TSubmission) {
  const {
    isEdited,
    addedConvo,
    userMessage,
    isContinued,
    isTemporary,
    isRegenerate,
    conversation,
    editedContent,
    ephemeralAgent,
    endpointOption,
    manualSkills,
    clientRequestId,
  } = submission;
  const { conversationId } = s.tConvoUpdateSchema.parse(conversation);
  const { endpoint: _e } = endpointOption as {
    endpoint: s.EModelEndpoint;
  };

  const endpoint = _e as s.EModelEndpoint;
  const server = `${EndpointURLs[s.EModelEndpoint.agents]}/${endpoint}`;

  const payload: t.TPayload = {
    ...userMessage,
    ...endpointOption,
    endpoint,
    addedConvo,
    isTemporary,
    isRegenerate,
    editedContent,
    conversationId,
    isContinued: !!(isEdited && isContinued),
    ephemeralAgent: s.isAssistantsEndpoint(endpoint) ? undefined : ephemeralAgent,
    manualSkills: s.isAssistantsEndpoint(endpoint) ? undefined : manualSkills,
    timezone: getUserTimezone(),
    clientRequestId,
  };

  return { server, payload };
}
