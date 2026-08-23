// 临时校验：用真实 JSONL 验证按模型聚合 + 最近记录，确认明细面板数据侧。
import { TailReader } from "./src/jsonl";
import {
  newTodayStats,
  newModelStats,
  addRecord,
  addModelRecord,
} from "./src/stats";

const p = "C:\\Users\\zxzxo\\AppData\\Roaming\\Code\\User\\globalStorage\\local.deepseek-usage\\usage.jsonl";
const recs = new TailReader(p).readNew();
const stats = newTodayStats();
const models = new Map<string, ReturnType<typeof newModelStats>>();
for (const r of recs) {
  if (addRecord(stats, r)) {
    let m = models.get(r.model);
    if (!m) {
      m = newModelStats();
      models.set(r.model, m);
    }
    addModelRecord(m, r);
  }
}
console.log("records:", recs.length);
console.log("today :", JSON.stringify(stats));
console.log("models:");
for (const [name, m] of models) {
  console.log(`  ${name}: cost=${m.cost.toFixed(4)} chCost=${m.chCost.toFixed(4)} t=${m.t} count=${m.count}`);
}
