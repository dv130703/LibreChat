import { genAzureEndpoint } from './azure';

describe('genAzureEndpoint', () => {
  test('generates correct endpoint URL for legacy instance name', () => {
    const url = genAzureEndpoint({
      azureOpenAIApiInstanceName: 'instanceName',
      azureOpenAIApiDeploymentName: 'deploymentName',
    });
    expect(url).toBe('https://instanceName.openai.azure.com/openai/deployments/deploymentName');
  });

  test('uses the instance name as-is when it already includes a full domain', () => {
    const url = genAzureEndpoint({
      azureOpenAIApiInstanceName: 'instanceName.cognitiveservices.azure.com',
      azureOpenAIApiDeploymentName: 'deploymentName',
    });
    expect(url).toBe(
      'https://instanceName.cognitiveservices.azure.com/openai/deployments/deploymentName',
    );
  });
});
