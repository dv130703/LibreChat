import type { ParsedTranscriptLine } from 'librechat-data-provider';

/** Alias, not a copy: the shape is defined once in `librechat-data-provider`'s
 *  `transcript` module (shared with the Node bridge and the correction-replay
 *  engine) so a field added there doesn't need a second edit here to match. */
export type ParsedLine = ParsedTranscriptLine;

export interface SpeakerOption {
  id: string;
  name: string;
  dotColorClass: string;
}
