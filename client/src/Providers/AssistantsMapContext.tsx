import { createContext, useContext } from 'react';
import type { TAssistantsMap } from 'librechat-data-provider';

export const AssistantsMapContext = createContext<TAssistantsMap>({});
export const useAssistantsMapContext = () => useContext(AssistantsMapContext);
