import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TTranscriptionPromptsResponse } from 'librechat-data-provider';
import PromptDisclosure from '../PromptDisclosure';

/** jsdom implements neither `<details>`'s own toggle behaviour nor a
 *  `fireEvent.toggle` helper, so the open state and the event it fires are
 *  both driven by hand here. */
function openDetails(details: HTMLDetailsElement): void {
  details.open = true;
  fireEvent(details, new Event('toggle', { bubbles: false }));
}

const refetch = jest.fn();
let mockQueryResult: {
  data?: TTranscriptionPromptsResponse;
  isLoading: boolean;
  isError: boolean;
  isFetched: boolean;
  refetch: jest.Mock;
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useTranscribePromptsQuery: () => mockQueryResult,
}));

const DISCLOSURE: TTranscriptionPromptsResponse = {
  enabled: true,
  model: 'qwen3:8b',
  endpoint: 'http://localhost:11434/v1',
  stages: [
    {
      stage: 'identifying_speakers',
      systemPrompt: 'You identify who the speakers are in an interview transcript.',
      exampleUserMessage: 'Known people who may appear in this recording:',
      tools: [
        {
          name: 'assign_speaker',
          description: 'Record that a specific unidentified speaker label belongs to a person.',
          parameters: '{\n  "type": "object"\n}',
        },
      ],
    },
  ],
};

beforeEach(() => {
  refetch.mockClear();
  mockQueryResult = {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetched: false,
    refetch,
  };
});

describe('PromptDisclosure', () => {
  /** Several KB of prompt text behind a dialog most people open to change a
   *  model - it must cost nothing until someone actually asks for it. */
  it('fetches nothing until the disclosure is opened', () => {
    render(<PromptDisclosure />);

    expect(refetch).not.toHaveBeenCalled();
  });

  it('fetches the prompts the first time it is opened, and not again after', () => {
    const { container, rerender } = render(<PromptDisclosure />);
    const details = container.querySelector('details') as HTMLDetailsElement;

    openDetails(details);
    expect(refetch).toHaveBeenCalledTimes(1);

    mockQueryResult = { ...mockQueryResult, data: DISCLOSURE, isFetched: true };
    rerender(<PromptDisclosure />);
    openDetails(details);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows each prompt verbatim, with the model and endpoint it goes to', () => {
    mockQueryResult = { ...mockQueryResult, data: DISCLOSURE, isFetched: true };
    const { container } = render(<PromptDisclosure />);

    expect(
      screen.getByText('You identify who the speakers are in an interview transcript.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Known people who may appear in this recording:')).toBeInTheDocument();
    expect(screen.getByText('assign_speaker')).toBeInTheDocument();
    expect(container.textContent).toContain('"type": "object"');
    expect(screen.getByText('com_ui_transcribe_prompts_destination')).toBeInTheDocument();
  });

  /** "Nothing is sent to any model here" is an answer to the question, not
   *  an empty state to hide. */
  it('says plainly when no model is configured at all', () => {
    mockQueryResult = {
      ...mockQueryResult,
      data: { enabled: false, stages: [] },
      isFetched: true,
    };
    render(<PromptDisclosure />);

    expect(screen.getByText('com_ui_transcribe_prompts_disabled')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_transcribe_prompts_system')).not.toBeInTheDocument();
  });

  it('reports a failure to load rather than showing an empty disclosure', () => {
    mockQueryResult = { ...mockQueryResult, isError: true, isFetched: true };
    render(<PromptDisclosure />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_transcribe_prompts_error');
  });
});
