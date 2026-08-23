// 代理子进程入口：node out/server.js --port 8080 --jsonl <path>
// 由扩展 spawn；也可独立运行便于调试。
import { startProxyServer } from "./proxyServer";
import { makeHdr, makeSep, setCurrency } from "./termfmt";
import { applyOverrides, setPricingTable } from "../pricing";

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const args: Record<string, string | undefined> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = argv[++i];
    else if (a === "--jsonl") args.jsonl = argv[++i];
    else if (a === "--pricing") args.pricing = argv[++i];
    else if (a === "--currency") args.currency = argv[++i];
    else if (a === "--rate") args.rate = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const port = Number(args.port ?? 8080);
  const jsonl = args.jsonl ?? "";
  if (!jsonl) {
    console.error("missing --jsonl path");
    process.exit(1);
  }
  if (args.pricing) {
    try {
      setPricingTable(applyOverrides(JSON.parse(args.pricing)));
    } catch {
      console.error("invalid --pricing JSON");
    }
  }
  if (args.currency === "usd" || args.currency === "cny") {
    setCurrency(args.currency, Number(args.rate ?? 6.74) || 6.74);
  }
  const server = await startProxyServer({ port, jsonlPath: jsonl });
  const hdr = makeHdr();
  console.log(`proxy started: http://127.0.0.1:${port}  jsonl=${jsonl}`);
  console.log(hdr);
  console.log(makeSep(hdr));

  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
