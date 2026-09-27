/**
 * Which word of a line is being spoken right now, as `[start, end)`
 * character offsets into that line's text - `null` when nothing should be
 * highlighted (no playback, or a line with no words in it).
 *
 * `ratio` is the playhead's progress through the line, the same 0-1 value
 * the row's progress bar is drawn from, so word tracking needs no timing
 * data the panel doesn't already hold.
 *
 * Words are weighted by their length: "extraordinary" takes longer to say
 * than "an", and character count is a good enough stand-in for that to keep
 * the highlight on the right word through a sentence.
 *
 * ponytail: an estimate, not real per-word timings - a long pause mid-line
 * will run the highlight ahead of the voice. The pipeline does produce true
 * word timings (forced alignment; they are kept in the diarization detail
 * file's `words`), so if the drift bothers anyone, look those up by absolute
 * time and keep this as the fallback for lines whose text has been edited
 * since.
 */
export function activeWordRange(text: string, ratio: number): [number, number] | null {
  if (!Number.isFinite(ratio) || ratio < 0) {
    return null;
  }

  const words: Array<[number, number]> = [];
  let totalLength = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    words.push([start, start + match[0].length]);
    totalLength += match[0].length;
  }
  if (words.length === 0) {
    return null;
  }

  const target = Math.min(ratio, 1) * totalLength;
  let spoken = 0;
  for (const word of words) {
    spoken += word[1] - word[0];
    if (target < spoken) {
      return word;
    }
  }
  return words[words.length - 1];
}
