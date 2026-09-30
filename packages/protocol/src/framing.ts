import { CaissonError } from "./errors.js";

export const BROKER_FRAME_MAX_BYTES = 16 * 1024 * 1024;

export function encodeBrokerFrame(payload: string): Buffer {
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.length > BROKER_FRAME_MAX_BYTES) {
    throw new CaissonError("PARAMS_INVALID", "broker frame exceeds maximum size");
  }
  const frame = Buffer.allocUnsafe(4 + bytes.length);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return frame;
}

export function decodeBrokerFrameLength(prefix: Buffer): number {
  if (prefix.length !== 4) {
    throw new CaissonError("PARAMS_INVALID", "broker frame prefix is invalid");
  }
  const length = prefix.readUInt32BE(0);
  if (length > BROKER_FRAME_MAX_BYTES) {
    throw new CaissonError("PARAMS_INVALID", "broker frame exceeds maximum size");
  }
  return length;
}
