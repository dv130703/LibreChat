export interface ParsedLine {
  /** Index into the flat, unreassigned parse of the transcript - stable
   *  identity for a line, used to target segment-reassign/text-edit corrections. */
  lineIndex: number;
  timestamp?: string;
  seconds?: number;
  /** This segment's own end time - the real boundary for bounded playback.
   *  Absent on transcripts saved before end timestamps were persisted. */
  endSeconds?: number;
  speaker?: string;
  text: string;
}

export interface SpeakerOption {
  id: string;
  name: string;
  dotColorClass: string;
}
