// 只声明用到的 Debug Adapter Protocol 子集。

export interface DapSource {
  name?: string;
  path?: string;
  sourceReference?: number;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
}

export interface DapThread {
  id: number;
  name: string;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
  presentationHint?: string;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  line?: number;
  message?: string;
}

export interface DapModule {
  id: number | string;
  name: string;
  path?: string;
  symbolStatus?: string;
  addressRange?: string;
}

export interface DapDisassembledInstruction {
  address: string;
  instructionBytes?: string;
  instruction: string;
  symbol?: string;
  location?: DapSource;
  line?: number;
  column?: number;
}

export type DapCapabilities = Record<string, unknown>;

export type DapConnectMode = "stdio" | "tcp" | "socket";

export interface DapAdapterConfig {
  command: string;
  args?: string[];
  languages?: string[];
  fileTypes?: string[];
  rootMarkers?: string[];
  launchDefaults?: Record<string, unknown>;
  attachDefaults?: Record<string, unknown>;
  connectMode?: DapConnectMode;
  acceptsDirectoryProgram?: boolean;
}

export interface ResolvedDapAdapter {
  name: string;
  command: string;
  resolvedCommand: string;
  args: string[];
  fileTypes: string[];
  rootMarkers: string[];
  launchDefaults: Record<string, unknown>;
  attachDefaults: Record<string, unknown>;
  connectMode: DapConnectMode;
  acceptsDirectoryProgram: boolean;
}

export interface DapProtocolMessage {
  seq: number;
  type: "request" | "response" | "event";
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: unknown;
  body?: unknown;
}
