import React from 'react';
import { useForm } from 'react-hook-form';
import { render, screen } from '@testing-library/react';
import SendButton from '../SendButton';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function Harness({
  defaultText = '',
  hasFiles = false,
  disabled = false,
}: {
  defaultText?: string;
  hasFiles?: boolean;
  disabled?: boolean;
}) {
  const { control } = useForm<{ text: string }>({ defaultValues: { text: defaultText } });
  return <SendButton control={control} hasFiles={hasFiles} disabled={disabled} />;
}

describe('SendButton', () => {
  it('is disabled with no text and no files', () => {
    render(<Harness />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('is enabled with text and no files', () => {
    render(<Harness defaultText="hello" />);
    expect(screen.getByTestId('send-button')).toBeEnabled();
  });

  it('is enabled with files and no text (caption-less attachment)', () => {
    render(<Harness hasFiles />);
    expect(screen.getByTestId('send-button')).toBeEnabled();
  });

  it('is disabled with files when the parent disables it (e.g. still uploading)', () => {
    render(<Harness hasFiles disabled />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('is disabled with only whitespace text and no files', () => {
    render(<Harness defaultText="   " />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });
});
