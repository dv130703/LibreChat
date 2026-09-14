const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { logAxiosError, generateShortLivedToken } = require('@librechat/api');

/**
 * Thrown when the RAG API recognizes the file's type but couldn't extract any
 * text from it (e.g. a scanned/image-only PDF with no embedded text layer).
 * Distinguished from other embedding failures so callers can attempt an
 * OCR-first fallback before giving up.
 */
class NoExtractableTextError extends Error {}

/**
 * Deletes a file from the vector database. This function takes a file object, constructs the full path, and
 * verifies the path's validity before deleting the file. If the path is invalid, an error is thrown.
 *
 * @param {ServerRequest} req - The request object from Express.
 * @param {MongoFile} file - The file object to be deleted. It should have a `filepath` property that is
 *                           a string representing the path of the file relative to the publicPath.
 *
 * @returns {Promise<void>}
 *          A promise that resolves when the file has been successfully deleted, or throws an error if the
 *          file path is invalid or if there is an error in deletion.
 */
const deleteVectors = async (req, file) => {
  if (!file.embedded || !process.env.RAG_API_URL) {
    return;
  }
  try {
    const jwtToken = generateShortLivedToken(req.user.id);

    return await axios.delete(`${process.env.RAG_API_URL}/documents`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      data: [file.file_id],
    });
  } catch (error) {
    logAxiosError({
      error,
      message: 'Error deleting vectors',
    });
    if (
      error.response &&
      error.response.status !== 404 &&
      (error.response.status < 200 || error.response.status >= 300)
    ) {
      logger.warn('Error deleting vectors, file will not be deleted');
      throw new Error(error.message || 'An error occurred during file deletion.');
    }
  }
};

/**
 * Uploads a file to the configured Vector database
 *
 * @param {Object} params - The params object.
 * @param {Object} params.req - The request object from Express. It should have a `user` property with an `id` representing the user
 * @param {Express.Multer.File} params.file - The file object, which is part of the request. The file object should
 *                                     have a `path` property that points to the location of the uploaded file.
 * @param {string} params.file_id - The file ID.
 * @param {string} [params.entity_id] - The entity ID for shared resources.
 * @param {Object} [params.storageMetadata] - Storage metadata for dual storage pattern.
 * @param {string} [params.logLabel] - Log-line prefix identifying the calling feature
 *   (e.g. `'TRANSCRIPTION'`); defaults to `'RAG'` for ordinary file-upload embedding.
 * @param {string} [params.text] - Pre-extracted text to embed instead of the original file
 *   (e.g. OCR output for a scanned document). Sent to the RAG API as a synthetic `.txt`
 *   upload so it reuses the existing plain-text extraction path server-side.
 *
 * @returns {Promise<{ filepath: string, bytes: number }>}
 *          A promise that resolves to an object containing:
 *            - filepath: The path where the file is saved.
 *            - bytes: The size of the file in bytes.
 * @throws {NoExtractableTextError} When the RAG API recognized the file type but found no
 *   extractable text (e.g. a scanned/image-only PDF) - callers may retry with `text` set.
 */
async function uploadVectors({
  req,
  file,
  file_id,
  entity_id,
  storageMetadata,
  logLabel = 'RAG',
  text,
}) {
  if (!process.env.RAG_API_URL) {
    throw new Error('RAG_API_URL not defined');
  }

  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const formData = new FormData();
    formData.append('file_id', file_id);
    if (text != null) {
      // Routes through the RAG API's plain-text decode path regardless of the
      // original file's real extension - only the chunking/embedding step cares
      // about this filename, LibreChat's own file record keeps the real one.
      formData.append('file', Buffer.from(text, 'utf8'), {
        filename: `${file_id}.txt`,
        contentType: 'text/plain',
      });
    } else {
      formData.append('file', fs.createReadStream(file.path));
    }
    if (entity_id != null && entity_id) {
      formData.append('entity_id', entity_id);
    }

    // Include storage metadata for RAG API to store with embeddings
    if (storageMetadata) {
      formData.append('storage_metadata', JSON.stringify(storageMetadata));
    }

    const formHeaders = formData.getHeaders();

    logger.info(
      `[${logLabel}] POST ${process.env.RAG_API_URL}/embed file="${file.originalname}" file_id=${file_id} entity=${entity_id || '-'}${text != null ? ' (pre-extracted text)' : ''}`,
    );
    const response = await axios.post(`${process.env.RAG_API_URL}/embed`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formHeaders,
      },
      // Unlike the sibling call to `/transcribe` (which sets a 15-minute
      // ceiling), this request had no timeout at all - a stalled embedding
      // step on the RAG server would hang here indefinitely, holding open
      // the Express connection and leaving the caller's temp files
      // un-cleaned-up (cleanup runs after this settles) for as long as the
      // RAG server stays unresponsive.
      timeout: 15 * 60 * 1000,
    });

    const responseData = response.data;
    logger.info(
      `[${logLabel}] embed result file_id=${file_id} status=${responseData.status} known_type=${responseData.known_type} chunks=${responseData.chunks ?? 'n/a'}`,
    );
    logger.debug('Response from embedding file', responseData);

    if (responseData.known_type === false) {
      throw new Error(`File embedding failed. The filetype ${file.mimetype} is not supported`);
    }

    if (!responseData.status) {
      throw new NoExtractableTextError(`No extractable text found in "${file.originalname}".`);
    }

    return {
      bytes: file.size,
      filename: file.originalname,
      filepath: FileSources.vectordb,
      embedded: Boolean(responseData.known_type),
    };
  } catch (error) {
    if (error instanceof NoExtractableTextError) {
      throw error;
    }
    logAxiosError({
      error,
      message: 'Error uploading vectors',
    });
    throw new Error(error.message || 'An error occurred during file upload.');
  }
}

module.exports = {
  deleteVectors,
  uploadVectors,
  NoExtractableTextError,
};
