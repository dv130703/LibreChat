const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const {
  generateShortLivedToken,
  logAxiosError,
  extractChunkEvidence,
} = require('@librechat/api');
const { Tools, EToolResources } = require('librechat-data-provider');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getFiles } = require('~/models');

const fileSearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.",
    },
  },
  required: ['query'],
};

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @param {string} [options.agentId] - The agent ID for file access control
 * @returns {Promise<{
 *   files: Array<{ file_id: string; filename: string; fromAgent: boolean }>,
 *   toolContext: string
 * }>}
 */
const primeFiles = async (options) => {
  const { tool_resources, req, agentId } = options;
  const file_ids = tool_resources?.[EToolResources.file_search]?.file_ids ?? [];
  const agentResourceIds = new Set(file_ids);
  const resourceFiles = tool_resources?.[EToolResources.file_search]?.files ?? [];

  // Get all files first
  const allFiles = (await getFiles({ file_id: { $in: file_ids } }, null, { text: 0 })) ?? [];

  // Filter by access if user and agent are provided
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

  dbFiles = dbFiles.concat(resourceFiles);

  let toolContext = `- Note: Semantic search is available through the ${Tools.file_search} tool but no files are currently loaded. Request the user to upload documents to search through.`;

  const files = [];
  for (let i = 0; i < dbFiles.length; i++) {
    const file = dbFiles[i];
    if (!file) {
      continue;
    }
    if (i === 0) {
      toolContext = `- Note: Use the ${Tools.file_search} tool to find relevant information within:`;
    }
    toolContext += `\n\t- ${file.filename}${
      agentResourceIds.has(file.file_id) ? '' : ' (just attached by user)'
    }`;
    files.push({
      file_id: file.file_id,
      filename: file.filename,
      fromAgent: agentResourceIds.has(file.file_id),
    });
  }

  return { files, toolContext };
};

/**
 * One structured log line per `file_search` invocation - everything needed
 * to diagnose "the LLM gave a bad answer" without guessing whether the cause
 * was retrieval or reasoning: which files were queried, how many candidates
 * came back per file, which chunks actually made the top-10 cut and their
 * relevance scores, whether any queried file's RAG index was stale (or had
 * never indexed successfully) at query time, and total latency. Chunk
 * content itself is deliberately not logged (only its length) - this is a
 * diagnostic trail, not a copy of retrieved text.
 */
function logRetrieval({ query, files, versionByFileId, startedAt, candidateCount, returned }) {
  const staleness = files
    .map((file) => {
      const version = versionByFileId.get(file.file_id);
      if (!version || version.transcriptVersion == null) {
        // Not a file kind that tracks canonical-text versions - nothing to
        // report, not a lookup failure.
        return null;
      }
      return {
        file_id: file.file_id,
        transcriptVersion: version.transcriptVersion,
        indexVersion: version.indexVersion,
        indexStatus: version.indexStatus,
        isStale: version.indexVersion !== version.transcriptVersion,
      };
    })
    .filter((entry) => entry !== null);

  logger.info('[RAG] file_search retrieval', {
    query,
    filesQueried: files.map((file) => file.file_id),
    candidateCount,
    returnedCount: returned.length,
    latencyMs: Date.now() - startedAt,
    staleness: staleness.length > 0 ? staleness : undefined,
    chunks: returned.map((result) => ({
      file_id: result.file_id,
      filename: result.filename,
      relevance: Number((1 - result.distance).toFixed(4)),
      page: result.page,
      chunkIndex: result.chunkIndex,
      // Recovered from the chunk's own text (see `extractChunkEvidence`) -
      // timing only, never speaker names, since a renamed speaker can carry
      // a real person's name and this log line is diagnostic metadata, not
      // a copy of retrieved content.
      startS: result.evidence?.startS,
      endS: result.evidence?.endS,
      contentLength: result.content?.length ?? 0,
    })),
  });
}

/**
 *
 * @param {Object} options
 * @param {string} options.userId
 * @param {Array<{ file_id: string; filename: string; fromAgent?: boolean }>} options.files
 * @param {string} [options.entity_id]
 * @param {boolean} [options.fileCitations=false] - Whether to include citation instructions
 * @returns
 */
const createFileSearchTool = async ({ userId, files, entity_id, fileCitations = false }) => {
  return tool(
    async ({ query }) => {
      const startedAt = Date.now();
      if (files.length === 0) {
        logger.warn(
          `[RAG] ${Tools.file_search} invoked with no files attached to the tool resource — nothing will be queried.`,
        );
        return ['No files to search. Instruct the user to add files for the search.', undefined];
      }
      const jwtToken = generateShortLivedToken(userId);
      if (!jwtToken) {
        return ['There was an error authenticating the file search request.', undefined];
      }

      // Version/index-status fields (see `IMongoFile.indexStatus`) are only
      // ever set on files with revisable canonical text - the Audio
      // Transcriber's transcript files, currently. `undefined` here for any
      // other file kind is expected, not a lookup failure - the log line
      // below just omits staleness for those.
      const versionByFileId = new Map(
        (
          (await getFiles({ file_id: { $in: files.map((file) => file.file_id) } }, null, {
            file_id: 1,
            transcriptVersion: 1,
            indexVersion: 1,
            indexStatus: 1,
          })) ?? []
        ).map((file) => [
          file.file_id,
          {
            transcriptVersion: file.transcriptVersion ?? null,
            indexVersion: file.indexVersion ?? null,
            indexStatus: file.indexStatus ?? null,
          },
        ]),
      );

      /**
       * @param {import('librechat-data-provider').TFile & { fromAgent?: boolean }} file
       * @returns {{ file_id: string, query: string, k: number, entity_id?: string }}
       */
      const createQueryBody = (file) => {
        const body = {
          file_id: file.file_id,
          query,
          k: 5,
        };
        // User-attached files are embedded under the user id (no entity);
        // only agent knowledge-base files carry the agent's entity_id.
        // Sending entity_id for user attachments makes the RAG API's entity
        // filter return no results for them. When files are provided by
        // primeFiles, fromAgent is always set; for callers that pass files
        // directly without the flag, the safe default is unscoped (no
        // entity_id).
        if (!entity_id || file.fromAgent !== true) {
          logger.info(
            `[RAG] POST ${process.env.RAG_API_URL}/query file_id=${file.file_id} entity=- k=${body.k} query="${query}"`,
          );
          return body;
        }
        body.entity_id = entity_id;
        logger.info(
          `[RAG] POST ${process.env.RAG_API_URL}/query file_id=${file.file_id} entity=${entity_id} k=${body.k} query="${query}"`,
        );
        logger.debug(`[${Tools.file_search}] RAG API /query body`, body);
        return body;
      };

      const queryPromises = files.map((file) =>
        axios
          .post(`${process.env.RAG_API_URL}/query`, createQueryBody(file), {
            headers: {
              Authorization: `Bearer ${jwtToken}`,
              'Content-Type': 'application/json',
            },
          })
          // `file_id` travels with its own response from here on, rather than
          // being recovered afterward by array index - `validResults` below
          // drops failed entries, which shifts every index after the first
          // failure. Recovering `file_id` via `files[fileIndex]` post-filter
          // (the previous approach) silently attributed later chunks to the
          // wrong file whenever an earlier file in the same batch failed.
          .then((response) => ({ file_id: file.file_id, response }))
          .catch((error) => {
            logAxiosError({
              message: 'Error encountered in `file_search` while querying file',
              error,
            });
            return null;
          }),
      );

      const results = await Promise.all(queryPromises);
      const validResults = results.filter((result) => result !== null);
      const candidateCount = validResults.reduce(
        (sum, result) => sum + (result.response.data?.length ?? 0),
        0,
      );
      logger.info(
        `[RAG] query returned ${candidateCount} chunk(s) across ${validResults.length}/${files.length} file(s)`,
      );

      if (validResults.length === 0) {
        logRetrieval({ query, files, versionByFileId, startedAt, candidateCount: 0, returned: [] });
        return ['No results found or errors occurred while searching the files.', undefined];
      }

      const formattedResults = validResults
        .flatMap(({ file_id, response }) =>
          response.data.map(([docInfo, distance]) => {
            const chunkIndex = docInfo.metadata.chunk_index ?? null;
            const version = versionByFileId.get(file_id);
            return {
              filename: docInfo.metadata.source.split('/').pop(),
              content: docInfo.page_content,
              distance,
              file_id,
              page: docInfo.metadata.page || null,
              // A stable identifier for exactly this chunk - `file_id` alone
              // is ambiguous once a file has more than one chunk. Falls back
              // to the bare file_id for chunks embedded before `chunk_index`
              // was surfaced (see `rag_server/app.py`'s `/query`).
              chunkIndex,
              chunkId: chunkIndex != null ? `${file_id}#${chunkIndex}` : file_id,
              transcriptVersion: version?.transcriptVersion ?? null,
              indexVersion: version?.indexVersion ?? null,
              // Recovered from the chunk's own text, since chunking isn't
              // turn-aware and carries no structured timing/speaker metadata
              // of its own - see `extractChunkEvidence`.
              evidence: extractChunkEvidence(docInfo.page_content),
            };
          }),
        )
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);

      if (formattedResults.length === 0) {
        logRetrieval({ query, files, versionByFileId, startedAt, candidateCount, returned: [] });
        return [
          'No content found in the files. The files may not have been processed correctly or you may need to refine your query.',
          undefined,
        ];
      }

      logRetrieval({
        query,
        files,
        versionByFileId,
        startedAt,
        candidateCount,
        returned: formattedResults,
      });

      const formattedString = formattedResults
        .map((result, index) => {
          const { evidence } = result;
          // Only surfaced when the chunk actually has timestamped/speaker
          // lines to report - a non-transcript chunk gets no evidence block
          // rather than a misleading blank one.
          const evidenceLines = [
            evidence.startS != null && evidence.endS != null
              ? `Time range: ${evidence.startS.toFixed(1)}s-${evidence.endS.toFixed(1)}s`
              : null,
            evidence.speakers.length > 0 ? `Speakers: ${evidence.speakers.join(', ')}` : null,
          ].filter(Boolean);
          return `File: ${result.filename}${
            fileCitations ? `\nAnchor: \\ue202turn0file${index} (${result.filename})` : ''
          }${evidenceLines.length > 0 ? `\n${evidenceLines.join('\n')}` : ''}\nRelevance: ${(1.0 - result.distance).toFixed(4)}\nContent: ${result.content}\n`;
        })
        .join('\n---\n');

      const sources = formattedResults.map((result) => ({
        type: 'file',
        fileId: result.file_id,
        content: result.content,
        fileName: result.filename,
        relevance: 1.0 - result.distance,
        pages: result.page ? [result.page] : [],
        pageRelevance: result.page ? { [result.page]: 1.0 - result.distance } : {},
        chunkId: result.chunkId,
        chunkIndex: result.chunkIndex,
        transcriptVersion: result.transcriptVersion,
        indexVersion: result.indexVersion,
        startS: result.evidence.startS ?? null,
        endS: result.evidence.endS ?? null,
        speakers: result.evidence.speakers,
      }));

      return [formattedString, { [Tools.file_search]: { sources, fileCitations } }];
    },
    {
      name: Tools.file_search,
      responseFormat: 'content_and_artifact',
      description: `Performs semantic search across attached "${Tools.file_search}" documents using natural language queries. This tool analyzes the content of uploaded files to find relevant information, quotes, and passages that best match your query. Use this to extract specific information or find relevant sections within the available documents.${
        fileCitations
          ? `

**CITE FILE SEARCH RESULTS:**
Use the EXACT anchor markers shown below (copy them verbatim) immediately after statements derived from file content. Reference the filename in your text:
- File citation: "The document.pdf states that... \\ue202turn0file0"  
- Page reference: "According to report.docx... \\ue202turn0file1"
- Multi-file: "Multiple sources confirm... \\ue200\\ue202turn0file0\\ue202turn0file1\\ue201"

**CRITICAL:** Output these escape sequences EXACTLY as shown (e.g., \\ue202turn0file0). Do NOT substitute with other characters like † or similar symbols.
**ALWAYS mention the filename in your text before the citation marker. NEVER use markdown links or footnotes.**`
          : ''
      }`,
      schema: fileSearchJsonSchema,
    },
  );
};

module.exports = { createFileSearchTool, primeFiles, fileSearchJsonSchema };
