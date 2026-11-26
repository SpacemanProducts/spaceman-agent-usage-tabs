// A finished goal's full report: the driver keeps the brain's whole final message
// in report-<goal id>.txt in her state dir, while the goal record and the log keep
// only its last 4000 characters. The panel's "Last goal · Show report" fetches it
// whole through `C report`. Falls back to the stored (clipped) report, then the
// fail reason. A goal id that isn't a plain id never names a file.
import fs from "node:fs";
import path from "node:path";

export const reportFile = (dir, id) => path.join(dir, `report-${id}.txt`);

export function goalReport(dir, goal) {
  if (!goal || typeof goal !== "object") return "";
  const id = String(goal.id || "");
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    try { const t = fs.readFileSync(reportFile(dir, id), "utf8").trim(); if (t) return t; } catch {}
  }
  const r = typeof goal.report === "string" ? goal.report.trim() : "";
  if (r) return r;
  return typeof goal.failReason === "string" ? goal.failReason.trim() : "";
}
