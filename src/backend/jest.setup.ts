// jest.setup.ts
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

// Export a non-async function that returns a promise
export default function(): Promise<void> {
  console.log('Setting up Guardrail environment variables from CloudFormation...');
  
  // Get Guardrail ID and Version from CloudFormation
  const cfnClient = new CloudFormationClient();
  const command = new DescribeStacksCommand({
    StackName: 'LlmObservabilityStack'
  });

  // Return the promise chain
  return cfnClient.send(command)
    .then(response => {
      const outputs = response.Stacks?.[0].Outputs;
      
      if (outputs) {
        // Find the GuardrailId and GuardrailVersion outputs
        const guardrailIdOutput = outputs.find(output => output.OutputKey === 'GuardrailId');
        const guardrailVersionOutput = outputs.find(output => output.OutputKey === 'GuardrailVersion');
        
        if (guardrailIdOutput?.OutputValue) {
          process.env.GUARDRAIL_ID = guardrailIdOutput.OutputValue;
          console.log(`Using Guardrail ID from CloudFormation: ${process.env.GUARDRAIL_ID}`);
        }
        
        if (guardrailVersionOutput?.OutputValue) {
          process.env.GUARDRAIL_VERSION = guardrailVersionOutput.OutputValue;
          console.log(`Using Guardrail Version from CloudFormation: ${process.env.GUARDRAIL_VERSION}`);
        }
      }
    })
    .catch(error => {
      console.error('Error fetching CloudFormation outputs:', error);
      console.log('Using default environment variables for Guardrails');
    });
}
