/**
 * Generates the Azure OpenAI API endpoint URL.
 *
 * Used by the Speech-to-Text and Text-to-Speech services, which support
 * Azure OpenAI as a provider independent of the chat/LLM provider selection.
 *
 * @param params - The parameters object.
 * @param params.azureOpenAIApiInstanceName - The Azure OpenAI API instance name.
 * @param params.azureOpenAIApiDeploymentName - The Azure OpenAI API deployment name.
 * @returns The complete endpoint URL for the Azure OpenAI API.
 */
export const genAzureEndpoint = ({
  azureOpenAIApiInstanceName,
  azureOpenAIApiDeploymentName,
}: {
  azureOpenAIApiInstanceName: string;
  azureOpenAIApiDeploymentName: string;
}): string => {
  // Support both old (.openai.azure.com) and new (.cognitiveservices.azure.com) endpoint formats
  // If instanceName already includes a full domain, use it as-is
  if (azureOpenAIApiInstanceName.includes('.azure.com')) {
    return `https://${azureOpenAIApiInstanceName}/openai/deployments/${azureOpenAIApiDeploymentName}`;
  }
  // Legacy format for backward compatibility
  return `https://${azureOpenAIApiInstanceName}.openai.azure.com/openai/deployments/${azureOpenAIApiDeploymentName}`;
};
