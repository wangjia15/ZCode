// LSP 与 DAP 共用的 base protocol：`Content-Length: N\r\n\r\n<N 字节 UTF-8 JSON>`。

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const CONTENT_LENGTH_PATTERN = /content-length:\s*(\d+)/i;

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]);
}

/** 持续读取 stream 中的帧并回调；返回解除监听的函数。 */
export function createMessageReader(
  stream: NodeJS.ReadableStream,
  onMessage: (message: unknown) => void,
  onError: (error: Error) => void,
): () => void {
  let buffer: Buffer = Buffer.alloc(0);

  const onData = (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = CONTENT_LENGTH_PATTERN.exec(header);
      if (!match) {
        // 头部损坏时丢弃到分隔符之后继续同步，避免整条连接卡死。
        buffer = buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        onError(new Error(`Invalid message header: ${header}`));
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      try {
        onMessage(JSON.parse(body));
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  stream.on("data", onData);
  return () => {
    stream.off("data", onData);
  };
}
