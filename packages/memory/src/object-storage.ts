import type { ReadOptions } from "@cerebro/contracts";
import { AwsClient } from "aws4fetch";

import { fetchWithDeadline } from "./embeddings";
import type { ObjectStorage } from "./types";

export const createS3ObjectStorage = (config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}): ObjectStorage & {
  readonly ensureBucket: (options: ReadOptions) => Promise<void>;
} => {
  const signer = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region ?? "us-east-1",
    retries: 0,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });
  const url = (key?: string) =>
    new URL(
      `${encodeURIComponent(config.bucket)}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`,
      `${config.endpoint.replace(/\/$/u, "")}/`
    ).toString();
  const request = async (
    key: string | undefined,
    method: string,
    options: ReadOptions,
    bytes?: Uint8Array
  ) => {
    const signed = await signer.sign(url(key), {
      method,
      ...(bytes ? { body: new Uint8Array(bytes).buffer } : {}),
    });
    const response = await fetchWithDeadline(signed, {}, options);
    if (!response.ok && !(method === "DELETE" && response.status === 404)) {
      throw new Error(`Object storage returned HTTP ${response.status}.`);
    }
    return response;
  };
  return {
    async delete(key, options) {
      await request(key, "DELETE", options);
    },
    async ensureBucket(options) {
      const signed = await signer.sign(url(), { method: "PUT" });
      const response = await fetchWithDeadline(signed, {}, options);
      if (!response.ok && response.status !== 409) {
        throw new Error("The artifact bucket could not be created.");
      }
    },
    async put(key, bytes, options) {
      await request(key, "PUT", options, bytes);
    },
    async read(key, options) {
      const response = await request(key, "GET", options);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
};
