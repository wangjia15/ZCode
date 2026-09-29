import { CodeIntelInvalidParamsError } from "../tool-contract.js";

export type ToolArgs = Record<string, unknown>;

export function asArgs(value: unknown): ToolArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodeIntelInvalidParamsError("arguments must be an object");
  }
  return value as ToolArgs;
}

export function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new CodeIntelInvalidParamsError(`${key} must be a string`);
  return value;
}

export function requireString(args: ToolArgs, key: string, action: string): string {
  const value = optionalString(args, key);
  if (!value) throw new CodeIntelInvalidParamsError(`${key} is required for ${action}`);
  return value;
}

export function optionalNumber(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CodeIntelInvalidParamsError(`${key} must be a number`);
  }
  return value;
}

export function optionalBoolean(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new CodeIntelInvalidParamsError(`${key} must be a boolean`);
  return value;
}

export function optionalStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CodeIntelInvalidParamsError(`${key} must be an array of strings`);
  }
  return value;
}

export function optionalRecord(args: ToolArgs, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CodeIntelInvalidParamsError(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** 秒 → 毫秒，带默认值与上限。 */
export function timeoutMs(args: ToolArgs, defaultSeconds: number, maxSeconds: number): number {
  const seconds = optionalNumber(args, "timeout") ?? defaultSeconds;
  return Math.min(Math.max(seconds, 1), maxSeconds) * 1000;
}

export class ToolFailure extends Error {
  override readonly name = "ToolFailure";
}
