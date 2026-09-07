import { TMessage } from 'librechat-data-provider';
import { MESSAGE_CONTENT_CLASSES } from '~/components/Chat/Messages/ui/messageShell';
import { cn } from '~/utils';
import MessageQuotes from './MessageQuotes';
import SkillPills from './SkillPills';
import Files from './Files';

const Container = ({ children, message }: { children: React.ReactNode; message?: TMessage }) => (
  <div className={cn(MESSAGE_CONTENT_CLASSES, '[.text-message+&]:mt-5')} dir="auto">
    {message?.isCreatedByUser === true && (
      <>
        <MessageQuotes quotes={message.quotes} />
        <Files message={message} />
        <SkillPills skills={message.alwaysAppliedSkills} source="always-apply" />
        <SkillPills skills={message.manualSkills} source="manual" />
      </>
    )}
    {children}
  </div>
);

export default Container;
