import { FileContext, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import { extractFileContext } from './context';

const req = { body: {}, config: {} } as never;
/** Real enough for the token-limit path: the limit is compared against this,
 *  and nothing here is trying to re-test the tokenizer. */
const tokenCountFn = async (text: string) => Math.ceil(text.length / 4);

const file = (overrides: Partial<IMongoFile>): IMongoFile =>
  ({
    filename: 'notes.md',
    source: FileSources.text,
    text: 'the quick brown fox',
    embedded: false,
    ...overrides,
  }) as IMongoFile;

describe('extractFileContext', () => {
  it('inlines ordinary un-embedded text attachments, as before', () => {
    return expect(
      extractFileContext({ attachments: [file({})], req, tokenCountFn }),
    ).resolves.toContain('the quick brown fox');
  });

  it('NEVER inlines a transcript, even when the embed failed', async () => {
    // The trap this guard exists for: a failed or stale embed flips
    // `embedded` to false, which used to make the whole transcript ride
    // along in every prompt for the rest of the conversation.
    const result = await extractFileContext({
      attachments: [
        file({
          filename: 'standup.mp4-transcript.md',
          context: FileContext.transcript_rag,
          text: 'SPEAKER 1: the entire recording, verbatim',
          embedded: false,
        }),
      ],
      req,
      tokenCountFn,
    });

    expect(result).toBeUndefined();
  });

  it('NEVER inlines the diarization-detail blob', async () => {
    const result = await extractFileContext({
      attachments: [
        file({
          filename: 'standup.mp4-diarization-detail.json',
          context: FileContext.transcript_diarization_detail,
          text: JSON.stringify({ speaker_embeddings: 'megabytes of this' }),
          embedded: false,
        }),
      ],
      req,
      tokenCountFn,
    });

    expect(result).toBeUndefined();
  });

  it('keeps inlining other attachments alongside a skipped transcript', async () => {
    const result = await extractFileContext({
      attachments: [
        file({
          filename: 'standup.mp4-transcript.md',
          context: FileContext.transcript_rag,
          text: 'VERBATIM TRANSCRIPT',
          embedded: false,
        }),
        file({ filename: 'agenda.md', text: 'discuss the roadmap' }),
      ],
      req,
      tokenCountFn,
    });

    expect(result).toContain('discuss the roadmap');
    expect(result).not.toContain('VERBATIM TRANSCRIPT');
  });

  it('still skips an embedded transcript, which RAG already serves', async () => {
    const result = await extractFileContext({
      attachments: [
        file({
          context: FileContext.transcript_rag,
          text: 'VERBATIM TRANSCRIPT',
          embedded: true,
        }),
      ],
      req,
      tokenCountFn,
    });

    expect(result).toBeUndefined();
  });
});
