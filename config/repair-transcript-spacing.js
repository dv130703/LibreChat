/**
 * Repairs transcripts whose words were run together ("Thankyouverymuch").
 *
 * Cause: for a window of time, `_build_speaker_segments` rebuilt each line by
 * concatenating per-word tokens with `""`. That is correct only for Whisper's
 * own tokens, which carry their leading space (`" Hello"`); WhisperX's forced
 * aligner splits on whitespace and returns BARE words, so every separator in
 * the line was dropped. Fixed at the source in
 * `transcription/whisperx_service.py` (`_join_words`) - this script repairs
 * transcripts that were already produced by the broken version.
 *
 * No re-transcription needed: the per-word data was never damaged, only the
 * line text derived from it. Each recording's `-diarization-detail` record
 * still holds `segments[].words[]` with correct word boundaries, so the line
 * text is rebuilt from those.
 *
 * Safety:
 * - Only the text of each line is rewritten. The `[start-end] Speaker N:`
 *   prefix is preserved byte-for-byte from the existing line, and the line
 *   count and order never change - so `lineIndex`-keyed corrections (speaker
 *   reassignments, text/time edits, inserted lines) stay pointing at the same
 *   lines they did before.
 * - Every line is verified to be identical to the original once all
 *   whitespace is removed from both. A line that fails that check is left
 *   untouched and reported, so this can only ever re-insert spacing - it can
 *   never silently change what was said.
 * - Dry run unless `--apply` is passed.
 *
 * Usage:
 *   node config/repair-transcript-spacing.js                  # report only
 *   node config/repair-transcript-spacing.js --apply          # repair all damaged
 *   node config/repair-transcript-spacing.js --apply <fileId> # repair one recording
 */

const path = require('path');
const mongoose = require('mongoose');
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const { TRANSCRIPT_LINE_PATTERN } = require('librechat-data-provider');
const connect = require('./connect');

/** Mirrors `WhisperXService._join_words` in
 *  `transcription/whisperx_service.py` - the two must agree, or a repaired
 *  transcript would not match what the pipeline now produces for the same
 *  audio. */
const ATTACHES_TO_PREVIOUS_WORD = new Set([
  ',',
  '.',
  '!',
  '?',
  ';',
  ':',
  ')',
  ']',
  '}',
  '%',
  '’',
  "'",
  '"',
  '”',
  '…',
]);

function joinWords(rawWords) {
  const out = [];
  for (const rawWord of rawWords) {
    if (!rawWord) {
      continue;
    }
    if (/^\s/.test(rawWord)) {
      out.push(rawWord);
      continue;
    }
    const needsSpace = out.length > 0 && !ATTACHES_TO_PREVIOUS_WORD.has(rawWord[0]);
    out.push(needsSpace ? ` ${rawWord}` : rawWord);
  }
  return out.join('').trim();
}

const stripWhitespace = (value) => value.replace(/\s+/g, '');

/** Splits one stored line into its `[start-end] Speaker N: ` prefix and its
 *  spoken text, using the same pattern every other consumer parses with. */
function splitLine(line) {
  const match = TRANSCRIPT_LINE_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  const text = match[4] ?? '';
  return { prefix: line.slice(0, line.length - text.length), text };
}

function rebuildTranscript(existingText, segments) {
  const rawLines = existingText.split('\n');
  const contentIndexes = rawLines
    .map((line, index) => (line.length > 0 ? index : -1))
    .filter((index) => index !== -1);

  if (contentIndexes.length !== segments.length) {
    return {
      ok: false,
      reason: `line/segment count mismatch (${contentIndexes.length} lines vs ${segments.length} segments)`,
    };
  }

  const repairedLines = [...rawLines];
  const skipped = [];
  let changed = 0;

  contentIndexes.forEach((lineIndex, segmentIndex) => {
    const segment = segments[segmentIndex];
    const parts = splitLine(rawLines[lineIndex]);
    if (!parts) {
      skipped.push({ lineIndex, reason: 'unparseable line' });
      return;
    }
    const words = Array.isArray(segment.words) ? segment.words : [];
    const rebuilt = joinWords(words.map((word) => word.word ?? ''));
    if (!rebuilt) {
      skipped.push({ lineIndex, reason: 'no word-level data for this segment' });
      return;
    }
    if (stripWhitespace(rebuilt) !== stripWhitespace(parts.text)) {
      skipped.push({ lineIndex, reason: 'rebuilt text differs beyond whitespace' });
      return;
    }
    if (rebuilt === parts.text) {
      return;
    }
    repairedLines[lineIndex] = `${parts.prefix}${rebuilt}`;
    changed += 1;
  });

  return { ok: true, text: repairedLines.join('\n'), changed, skipped };
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const cosmetic = args.includes('--include-cosmetic');
  const only = args.find((arg) => !arg.startsWith('--'));

  await connect();
  const db = mongoose.connection.db;
  const files = db.collection('files');

  const query = {
    file_id: only ? `${only.replace(/-transcript$/, '')}-transcript` : /-transcript$/,
  };
  const transcripts = await files
    .find(query, { projection: { file_id: 1, filename: 1, createdAt: 1, text: 1 } })
    .sort({ createdAt: -1 })
    .toArray();

  if (transcripts.length === 0) {
    console.log('No transcript records found.');
    await mongoose.disconnect();
    return;
  }

  console.log(
    `Scanning ${transcripts.length} transcript(s)${apply ? '' : ' (dry run - pass --apply to write)'}\n`,
  );
  let repairedCount = 0;

  for (const transcript of transcripts) {
    const sourceId = transcript.file_id.replace(/-transcript$/, '');
    const existingText = transcript.text ?? '';
    if (!existingText) {
      continue;
    }

    const detail = await files.findOne(
      { file_id: `${sourceId}-diarization-detail` },
      { projection: { text: 1 } },
    );
    if (!detail?.text) {
      console.log(`- ${transcript.file_id}: SKIP (no diarization-detail record to rebuild from)`);
      continue;
    }

    let segments;
    try {
      segments = JSON.parse(detail.text).segments;
    } catch (error) {
      console.log(
        `- ${transcript.file_id}: SKIP (diarization-detail is not valid JSON: ${error.message})`,
      );
      continue;
    }
    if (!Array.isArray(segments)) {
      console.log(`- ${transcript.file_id}: SKIP (diarization-detail has no segments array)`);
      continue;
    }

    const result = rebuildTranscript(existingText, segments);
    if (!result.ok) {
      console.log(`- ${transcript.file_id}: SKIP (${result.reason})`);
      continue;
    }
    if (result.changed === 0) {
      console.log(`- ${transcript.file_id}: OK (already correctly spaced)`);
      continue;
    }

    const before = (existingText.match(/ /g) || []).length;
    const after = (result.text.match(/ /g) || []).length;

    /** Rewriting the text invalidates the RAG index (hence the `stale` mark
     *  below), which costs this recording its searchability until it is
     *  re-embedded. Worth it to recover a transcript with its spacing gone;
     *  not worth it for an undamaged one where the rebuild only normalises a
     *  stray space before punctuation ("bowl ?" -> "bowl?"), which is what a
     *  net-zero-or-negative space delta means. Those are left alone unless
     *  explicitly asked for. */
    if (after <= before && !cosmetic) {
      console.log(
        `- ${transcript.file_id}: SKIP (${result.changed} cosmetic spacing diff(s) only, ` +
          'not damaged - pass --include-cosmetic to normalise anyway)',
      );
      continue;
    }

    console.log(
      `- ${transcript.file_id}: ${result.changed} line(s) need repair, spaces ${before} -> ${after}` +
        (result.skipped.length ? `, ${result.skipped.length} line(s) left untouched` : ''),
    );
    for (const skip of result.skipped.slice(0, 5)) {
      console.log(`    line ${skip.lineIndex}: ${skip.reason}`);
    }

    if (apply) {
      await files.updateOne(
        { file_id: transcript.file_id },
        { $set: { text: result.text, indexStatus: 'stale' }, $inc: { transcriptVersion: 1 } },
      );
      repairedCount += 1;
      console.log('    repaired, and its RAG index marked stale for re-embedding');
    }
  }

  console.log(
    apply
      ? `\nDone. Repaired ${repairedCount} transcript(s).`
      : '\nDry run complete. Re-run with --apply to write these changes.',
  );
  await mongoose.disconnect();
})().catch((error) => {
  console.error('Failed:', error);
  process.exit(1);
});
