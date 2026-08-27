import { useParams } from 'react-router-dom';
import UploadStep from './UploadStep';
import Workspace from './Workspace';

/**
 * Dedicated Audio Transcriber section - separate from the normal chat window.
 * No `conversationId` param: upload/configure/transcribe. Once a transcript
 * exists (fresh, or reopened via a bookmarked URL), render the two-pane
 * transcript+chat workspace.
 */
export default function AudioTranscriberPage() {
  const { conversationId } = useParams();

  if (!conversationId) {
    return <UploadStep />;
  }

  return <Workspace conversationId={conversationId} />;
}
