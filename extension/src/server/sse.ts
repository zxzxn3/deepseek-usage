// SSE 流式响应解析：从 data: 行里提取最后一个带 usage 的对象（[DONE] 之前）。
// 跨块缓冲：数据可能被切成多段到达（如 8KB 块边界），用内部 buf 保留不完整的行。
export class SseUsageExtractor {
  private buf = "";
  usage: any = null;

  push(text: string): void {
    this.buf += text;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? ""; // 最后一段可能不完整，留到下次
    for (const raw of lines) this.consume(raw);
  }

  /** 流结束：处理残留的未换行片段。 */
  flush(): void {
    if (!this.buf) return;
    const raw = this.buf;
    this.buf = "";
    this.consume(raw);
  }

  private consume(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return;
    const p = line.slice(5).trim();
    if (!p || p === "[DONE]") return;
    try {
      this.usage = JSON.parse(p).usage ?? this.usage;
    } catch {
      // 忽略无法解析的行
    }
  }
}
