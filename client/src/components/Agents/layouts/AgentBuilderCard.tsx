import type { ReactNode } from 'react';
import { cn } from '~/utils';

interface AgentBuilderCardProps {
  id?: string;
  className?: string;
  children: ReactNode;
}

/** A visually distinct section surface for the full-page Agent Builder
 * (Identity, Instructions, Tools, Skills, Configuration, File Context,
 * Support Contact), matching the card-based layout that page follows. */
export default function AgentBuilderCard({ id, className, children }: AgentBuilderCardProps) {
  return (
    <div
      id={id}
      className={cn('rounded-xl border border-border-light bg-surface-secondary p-5', className)}
    >
      {children}
    </div>
  );
}
