import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DeleteLineDialog from '../DeleteLineDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const pending = { lineIndex: 4, speaker: 'Priya Selwyn', text: 'I have not seen those invoices.' };

describe('DeleteLineDialog', () => {
  it('stays closed when nothing is pending', () => {
    render(<DeleteLineDialog pending={null} onOpenChange={jest.fn()} onConfirm={jest.fn()} />);

    expect(screen.queryByText('com_ui_transcript_delete_line_title')).not.toBeInTheDocument();
  });

  /** The guard against a misclick is being able to read the line back - a
   *  bare "are you sure?" gives the reviewer no way to notice the menu
   *  opened on the wrong row. */
  it('quotes the line being deleted, with its speaker', () => {
    render(<DeleteLineDialog pending={pending} onOpenChange={jest.fn()} onConfirm={jest.fn()} />);

    expect(screen.getByText('I have not seen those invoices.')).toBeInTheDocument();
    expect(screen.getByText('Priya Selwyn')).toBeInTheDocument();
  });

  it('deletes nothing until the destructive button is pressed', () => {
    const onConfirm = jest.fn();
    render(<DeleteLineDialog pending={pending} onOpenChange={jest.fn()} onConfirm={onConfirm} />);

    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('com_ui_delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('closes without deleting when cancelled', () => {
    const onConfirm = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <DeleteLineDialog pending={pending} onOpenChange={onOpenChange} onConfirm={onConfirm} />,
    );

    fireEvent.click(screen.getByText('com_ui_cancel'));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  /** A blank inserted line is the exact case that prompted the delete
   *  option; it must still be identifiable in the prompt. */
  it('labels an empty line rather than showing nothing', () => {
    render(
      <DeleteLineDialog
        pending={{ lineIndex: 2, speaker: 'Speaker 1', text: '   ' }}
        onOpenChange={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByText('com_ui_transcript_delete_line_empty')).toBeInTheDocument();
  });

  it('omits the attribution for a line with no speaker', () => {
    render(
      <DeleteLineDialog
        pending={{ lineIndex: 2, text: 'Unattributed words.' }}
        onOpenChange={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByText('Unattributed words.')).toBeInTheDocument();
    expect(screen.queryByText('Speaker 1')).not.toBeInTheDocument();
  });
});
