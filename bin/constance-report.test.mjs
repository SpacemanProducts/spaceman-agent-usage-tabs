// goalReport: the whole report file wins over the clipped copy on the goal;
// then the stored report, then the fail reason; odd ids never name a file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { goalReport, reportFile } from "./constance-report.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-report-"));
try {
  const full = "Start of the report.\n" + "x".repeat(6000) + "\nEnd.";
  fs.writeFileSync(reportFile(dir, "4d893c99"), full + "\n");
  assert.equal(goalReport(dir, { id: "4d893c99", report: full.slice(-4000) }), full, "the whole file, not the clipped 4000");
  assert.equal(goalReport(dir, { id: "nofile", report: "  kept copy  " }), "kept copy", "no file: the stored report");
  assert.equal(goalReport(dir, { id: "nofile", report: "", failReason: "Claude exited 3 times" }), "Claude exited 3 times");
  fs.writeFileSync(reportFile(dir, "blank"), "   \n");
  assert.equal(goalReport(dir, { id: "blank", report: "stored" }), "stored", "an empty file falls back");
  // A crafted id never reaches outside the state dir.
  fs.writeFileSync(path.join(path.dirname(dir), "report-..secret.txt"), "secret");
  for (const id of ["../x", "a/b", "..", "", "a".repeat(65)]) assert.equal(goalReport(dir, { id, report: "safe" }), "safe", JSON.stringify(id));
  fs.rmSync(path.join(path.dirname(dir), "report-..secret.txt"), { force: true });
  for (const g of [null, undefined, "x", 3, {}]) assert.equal(goalReport(dir, g), "", JSON.stringify(g));
  assert.equal(goalReport(dir, { id: "nofile", report: 5, failReason: {} }), "", "wrong types give nothing, never a crash");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("constance-report: tests passed");
