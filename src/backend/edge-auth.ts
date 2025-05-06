import { CloudFrontRequestEvent, CloudFrontRequestHandler } from "aws-lambda";
import { createHash } from "crypto";

/**
 * Calculate SHA256 hash of a payload string
 * @param payload - The payload to hash
 * @returns SHA256 hash as a hexadecimal string
 */
const hashPayload = async (payload: string): Promise<string> => {
  /*
  const encoder = new TextEncoder().encode(payload);
  const hash = await crypto.subtle.digest("SHA-256", encoder);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  */
  return createHash('sha256').update(payload).digest('hex');
};

/**
 * Lambda@Edge handler for CloudFront viewer requests
 * Adds x-amz-content-sha256 header with SHA256 hash of the request body
 * This is required for Lambda function URLs with AWS_IAM auth when accessed through CloudFront
 */
export const handler: CloudFrontRequestHandler = async (
  event: CloudFrontRequestEvent
) => {
  const request = event.Records[0].cf.request;
  console.log("Original request:", JSON.stringify(request));

  // If there's no body, return the request as is
  if (!request.body?.data) {
    console.log("No request body found, skipping hash calculation");
    return request;
  }

  try {
    // Decode the base64-encoded body
    const body = request.body.data;
    const decodedBody = Buffer.from(body, "base64").toString("utf-8");
    
    // Calculate SHA256 hash of the body
    const contentHash = await hashPayload(decodedBody);
    console.log(`Calculated content hash: ${contentHash}`);
    
    // Add the x-amz-content-sha256 header
    request.headers["x-amz-content-sha256"] = [
      { key: "x-amz-content-sha256", value: contentHash }
    ];
    
    console.log("Modified request:", JSON.stringify(request));
    return request;
  } catch (error) {
    console.error("Error processing request:", error);
    // In case of error, return the original request
    // This allows the request to proceed, though it might fail at the Lambda function URL
    return request;
  }
};
