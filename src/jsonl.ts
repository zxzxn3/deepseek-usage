// JSONL 存储：一次请求一行，存"事实"（UTC 时间戳 + 原始 tokens），计价在展示层。
import * as fs from "fs";

export interface UsageRecord {
  ts: string; // UTC ISO
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  stream: boolean;
  status: number;
  error?: string | null;
}

/** 追加一条（供代理子进程写）。 */
export function appendRecord(jsonlPath: string, rec: UsageRecord): void {
  fs.appendFileSync(jsonlPath, JSON.stringify(rec) + "\n", "utf8");
}

/** 账户余额记录（代理按请求顺带查询 /user/balance 后写，扩展读取最新一条）。 */
export interface BalanceRecord {
  ts: string; // UTC ISO
  totalCny: number | null; // CNY 总余额；查询失败为 null
  isAvailable: boolean;
}

/** 追加一条余额（供代理子进程写，独立于 usage 文件）。 */
export function appendBalance(balancePath: string, rec: BalanceRecord): void {
  fs.appendFileSync(balancePath, JSON.stringify(rec) + "\n", "utf8");
}

/**
 * 增量尾部读取器：记住已读字节偏移，只解析新追加的完整行。
 * 用于扩展轮询——代理写、扩展读，互不干扰。
 */
export class TailReader {
  private offset = 0;

  constructor(private readonly jsonlPath: string) {
    // 默认从头读（首次 readNew 返回全部现有记录，便于初始化聚合）
  }

  /** 回退到文件头（如北京日切换后重建当天聚合）。 */
  reset(): void {
    this.offset = 0;
  }

  /** 返回自上次读取以来的新记录（跳过不完整的尾行）。 */
  readNew(): UsageRecord[] {
    if (!fs.existsSync(this.jsonlPath)) return [];
    const buf = fs.readFileSync(this.jsonlPath, "utf8");
    if (buf.length < this.offset) this.offset = 0; // 文件被重写/截断
    const tail = buf.slice(this.offset);
    const lines = tail.split("\n");
    const complete = lines.slice(0, -1); // 最后一段可能是写了一半的行
    const lastPartial = lines[lines.length - 1];

    // 若 tail 不以换行结尾，则最后一段是不完整行，回退 offset 不消费它
    let consumed = tail.length;
    if (lastPartial !== undefined && !tail.endsWith("\n")) {
      consumed -= lastPartial.length;
    }
    this.offset += consumed;

    const out: UsageRecord[] = [];
    for (const line of complete) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as UsageRecord);
      } catch {
        // 单行损坏则跳过（不阻塞后续）
      }
    }
    return out;
  }
}
