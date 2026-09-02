import { parseTranscriptText } from './corrections';

/**
 * What a retrieved RAG chunk can prove about itself: the time span and
 * speakers its own text covers, recovered by re-parsing the chunk's
 * `[start-end] Speaker N: text` lines with the same convention
 * `corrections.ts` already uses. Chunking is generic, not turn-aware (see
 * `rag_server/extract.py`'s `chunk_text`), so no structured per-chunk
 * timestamp/speaker metadata exists anywhere else to read instead - this is
 * the only place that information can come from today.
 *
 * `startS`/`endS` are undefined when the chunk has no timestamped lines at
 * all (a non-transcript document, or a chunk boundary that split off before
 * the first bracketed line) - an honest "no evidence" rather than a guess.
 */
export interface ChunkEvidence {
  startS?: number;
  endS?: number;
  speakers: string[];
}

export function extractChunkEvidence(chunkText: string): ChunkEvidence {
  let startS: number | undefined;
  let endS: number | undefined;
  const speakers = new Set<string>();

  for (const line of parseTranscriptText(chunkText)) {
    if (line.seconds != null) {
      startS = startS == null ? line.seconds : Math.min(startS, line.seconds);
    }
    if (line.endSeconds != null) {
      endS = endS == null ? line.endSeconds : Math.max(endS, line.endSeconds);
    }
    if (line.speaker != null) {
      speakers.add(line.speaker);
    }
  }

  return { startS, endS, speakers: Array.from(speakers) };
}
