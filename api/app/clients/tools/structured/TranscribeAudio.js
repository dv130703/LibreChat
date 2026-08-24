const { z } = require('zod');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const { Tools, EToolResources } = require('librechat-data-provider');
const { generateShortLivedToken, logAxiosError } = require('@librechat/api');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFiles } = require('~/models');

const AUDIO_VIDEO_PREFIX = /^(audio|video)\//;

const transcribeAudioSchema = z.object({
  diarize: z
    .boolean()
    .optional()
    .describe('Label who is speaking (speaker diarization). Defaults to true.'),
  min_speakers: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Hint: minimum number of distinct speakers expected in the recording.'),
  max_speakers: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Hint: maximum number of distinct speakers expected in the recording.'),
  language: z
    .string()
    .optional()
    .describe('ISO 639-1 language code to force (e.g. "en"). Omit to auto-detect.'),
});

/** "125.4" seconds -> "02:05". Segments run well past an hour for long recordings. */
function formatTimestamp(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Resolves which audio/video files are available to transcribe this turn, the
 * same way `fileSearch.js`'s `primeFiles` resolves file_search's files: from
 * the `transcribe_audio` tool_resources bucket, not from a model-supplied id
 * (the model has no way to know a raw file_id that was never shown to it).
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @param {string} [options.agentId]
 * @returns {Promise<{
 *   files: Array<{ file_id: string; filename: string; filepath: string; source: string; type: string }>,
 *   toolContext: string
 * }>}
 */
const primeFiles = async (options) => {
  const { tool_resources, req, agentId } = options;
  const file_ids = tool_resources?.[EToolResources.transcribe_audio]?.file_ids ?? [];
  const resourceFiles = tool_resources?.[EToolResources.transcribe_audio]?.files ?? [];

  const allFiles = (await getFiles({ file_id: { $in: file_ids } }, null, { text: 0 })) ?? [];

  let dbFiles;
  if (req?.user?.id && agentId) {
    dbFiles = await filterFilesByAgentAccess({
      files: allFiles,
      userId: req.user.id,
      role: req.user.role,
      agentId,
    });
  } else {
    dbFiles = allFiles;
  }
  dbFiles = dbFiles.concat(resourceFiles).filter((file) => AUDIO_VIDEO_PREFIX.test(file?.type || ''));

  let toolContext = `- Note: The ${Tools.transcribe_audio} tool is available but no audio/video files are currently attached. Ask the user to upload one.`;
  if (dbFiles.length > 0) {
    toolContext = `- Note: Use the ${Tools.transcribe_audio} tool to transcribe:`;
    for (const file of dbFiles) {
      toolContext += `\n\t- ${file.filename}`;
    }
  }

  return { files: dbFiles, toolContext };
};

/**
 * Creates the transcribe_audio tool: sends every audio/video file attached
 * via the transcribe_audio tool_resources bucket to the RAG server's WhisperX
 * endpoint and returns a speaker-labelled, timestamped transcript for each.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {Array<{ file_id: string; filename: string; filepath: string; source: string; type: string }>} params.files
 * @returns {import('@librechat/agents/langchain/tools').DynamicStructuredTool}
 */
function createTranscribeAudioTool({ req, files }) {
  return tool(
    async ({ diarize = true, min_speakers, max_speakers, language }) => {
      if (!files || files.length === 0) {
        return ['No audio or video files are attached. Ask the user to upload one.', undefined];
      }
      if (!process.env.RAG_API_URL) {
        return [
          'Audio transcription is not configured on this server (RAG_API_URL is not set).',
          undefined,
        ];
      }

      const jwtToken = generateShortLivedToken(req.user.id);
      const transcriptions = [];

      for (const file of files) {
        try {
          const { getDownloadStream } = getStrategyFunctions(file.source);
          const stream = await getDownloadStream(req, file.filepath);

          const formData = new FormData();
          formData.append('file', stream, { filename: file.filename, contentType: file.type });
          formData.append('diarize', String(diarize));
          if (min_speakers != null) {
            formData.append('min_speakers', String(min_speakers));
          }
          if (max_speakers != null) {
            formData.append('max_speakers', String(max_speakers));
          }
          if (language) {
            formData.append('language', language);
          }

          logger.info(
            `[transcribe_audio] POST ${process.env.RAG_API_URL}/transcribe file_id=${file.file_id}`,
          );
          const response = await axios.post(`${process.env.RAG_API_URL}/transcribe`, formData, {
            headers: {
              Authorization: `Bearer ${jwtToken}`,
              accept: 'application/json',
              ...formData.getHeaders(),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            // WhisperX on a long recording can legitimately take minutes, even
            // with large-v3-turbo on a GPU.
            timeout: 15 * 60 * 1000,
          });

          const { segments = [], language: detectedLanguage, diagnostics } = response.data ?? {};
          if (segments.length === 0) {
            transcriptions.push({
              file,
              text: `"${file.filename}": transcription produced no speech segments.`,
              segments,
            });
            continue;
          }

          const transcript = segments
            .map(
              (segment) => `[${formatTimestamp(segment.start)}] ${segment.speaker}: ${segment.text}`,
            )
            .join('\n');
          const speakerCount =
            diagnostics?.diarization_speaker_count || new Set(segments.map((s) => s.speaker)).size;

          transcriptions.push({
            file,
            text: `"${file.filename}" (language: ${detectedLanguage}, ${speakerCount} speaker(s), ${segments.length} segment(s)):\n\n${transcript}`,
            segments,
            language: detectedLanguage,
            diagnostics,
          });
        } catch (error) {
          logAxiosError({ message: 'Error encountered in `transcribe_audio`', error });
          transcriptions.push({
            file,
            text: `"${file.filename}": error transcribing - ${error.response?.data?.detail || error.message}`,
          });
        }
      }

      const content = transcriptions.map((t) => t.text).join('\n\n---\n\n');
      return [
        content,
        {
          [Tools.transcribe_audio]: transcriptions.map((t) => ({
            fileId: t.file.file_id,
            filename: t.file.filename,
            segments: t.segments,
            language: t.language,
            diagnostics: t.diagnostics,
          })),
        },
      ];
    },
    {
      name: Tools.transcribe_audio,
      responseFormat: 'content_and_artifact',
      description:
        'Transcribes the audio/video file(s) the user attached for transcription into a speaker-labelled, timestamped transcript using WhisperX. No file reference is needed - it transcribes whatever is currently attached.',
      schema: transcribeAudioSchema,
    },
  );
}

module.exports = createTranscribeAudioTool;
module.exports.createTranscribeAudioTool = createTranscribeAudioTool;
module.exports.primeFiles = primeFiles;
