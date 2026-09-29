import { CaissonError } from "@caisson/protocol";
import { z } from "zod";

export const BinaryContentSchema = z
  .object({
    encoding: z.enum(["utf8", "base64"]),
    data: z.string(),
  })
  .strict();

export type BinaryContent = z.infer<typeof BinaryContentSchema>;

export function decodeContent(input: BinaryContent, maximumBytes: number): Buffer {
  const bytes =
    input.encoding === "utf8" ? Buffer.from(input.data, "utf8") : decodeBase64(input.data);
  if (bytes.length > maximumBytes) {
    throw new CaissonError("PARAMS_INVALID", "request body exceeds configured size limit");
  }
  return bytes;
}

export function encodeContent(bytes: Buffer, contentType: string | undefined): BinaryContent {
  if (isTextContentType(contentType)) {
    return { encoding: "utf8", data: bytes.toString("utf8") };
  }
  return { encoding: "base64", data: bytes.toString("base64") };
}

export function isTextContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined) return false;
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/javascript" ||
    mediaType === "application/x-javascript" ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml")
  );
}

function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new CaissonError("PARAMS_INVALID", "invalid base64 request body");
  }
  return Buffer.from(value, "base64");
}
