import { useMemo, useState, useCallback, memo } from 'react';
import type { TFile, TMessage } from 'librechat-data-provider';
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import { useConversationTranscriptsQuery } from '~/data-provider';
import { isAudioOrVideoMimeType } from '~/utils';
import TranscriptCard from './Parts/TranscriptCard';
import FilePreviewDialog from './FilePreviewDialog';
import Image from './Image';

const Files = ({ message }: { message?: TMessage }) => {
  const imageFiles = useMemo(() => {
    return message?.files?.filter((file) => file.type?.startsWith('image/')) || [];
  }, [message?.files]);

  const audioVideoFiles = useMemo(() => {
    return message?.files?.filter((file) => isAudioOrVideoMimeType(file.type)) || [];
  }, [message?.files]);

  /** One query for the whole conversation, shared with the transcript panel
   *  and the composer's stop affordance - the single read model that answers
   *  which recordings exist and what state each is in. This used to be a
   *  second, message-scoped status poll, which meant a recording's chip and
   *  its panel could disagree, and which returned nothing for the first
   *  round trip so an audio/video file rendered briefly as a plain chip
   *  before becoming a `TranscriptCard`. That flash was half of defect 1. */
  const { data: transcriptsData } = useConversationTranscriptsQuery(
    message?.conversationId ?? undefined,
  );

  /** Keyed by source file id so a message carrying several recordings pairs
   *  each with its own record in one pass. */
  const recordsBySourceId = useMemo(
    () => new Map((transcriptsData?.transcripts ?? []).map((entry) => [entry.sourceFileId, entry])),
    [transcriptsData],
  );

  /** Audio/video attached via composer transcription. Anything else - a
   *  recording attached as a plain file because the user declined
   *  transcription, or because the endpoint reads audio natively - has no
   *  record here and falls through to the ordinary chip. */
  const transcribableFiles = useMemo(
    () => audioVideoFiles.filter((file) => recordsBySourceId.has(file.file_id ?? '')),
    [audioVideoFiles, recordsBySourceId],
  );

  const otherFiles = useMemo(() => {
    return (
      message?.files?.filter(
        (file) => !file.type?.startsWith('image/') && !recordsBySourceId.has(file.file_id ?? ''),
      ) || []
    );
  }, [message?.files, recordsBySourceId]);

  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  return (
    <>
      {transcribableFiles.length > 0 &&
        transcribableFiles.map((file) => (
          <TranscriptCard key={file.file_id} record={recordsBySourceId.get(file.file_id ?? '')!} />
        ))}
      {otherFiles.length > 0 &&
        otherFiles.map((file) => (
          <FileContainer
            key={file.file_id}
            file={file as TFile}
            onClick={() => setSelectedFile(file)}
          />
        ))}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <Image
            key={file.file_id}
            imagePath={file.preview ?? file.filepath ?? ''}
            height={file.height ?? 1920}
            width={file.width ?? 1080}
            altText={file.filename ?? 'Uploaded Image'}
          />
        ))}
      <FilePreviewDialog
        open={selectedFile !== null}
        onOpenChange={handleClose}
        fileName={selectedFile?.filename ?? ''}
        fileId={selectedFile?.file_id}
        filePath={selectedFile?.filepath}
        fileType={selectedFile?.type ?? undefined}
        fileSize={(selectedFile as TFile)?.bytes}
      />
    </>
  );
};

export default memo(Files);
