import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withGeneratedFileRollback } from "../scripts/run-feed-cycle.mjs";

test("restores generated Live files when publication preparation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "all-we-need-live-rollback-"));
  const existingPath = join(directory, "live-feed.json");
  const newPath = join(directory, "traffic-summary.json");
  await writeFile(existingPath, "published\n", "utf8");

  try {
    await assert.rejects(
      withGeneratedFileRollback([existingPath, newPath], async () => {
        await writeFile(existingPath, "pending localization\n", "utf8");
        await writeFile(newPath, "partial traffic\n", "utf8");
        throw new Error("localization failed");
      }),
      /localization failed/,
    );

    assert.equal(await readFile(existingPath, "utf8"), "published\n");
    await assert.rejects(readFile(newPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps generated Live files when publication preparation succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "all-we-need-live-commit-"));
  const livePath = join(directory, "live-feed.json");
  await writeFile(livePath, "published\n", "utf8");

  try {
    const result = await withGeneratedFileRollback([livePath], async () => {
      await writeFile(livePath, "localized\n", "utf8");
      return "ready";
    });

    assert.equal(result, "ready");
    assert.equal(await readFile(livePath, "utf8"), "localized\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
