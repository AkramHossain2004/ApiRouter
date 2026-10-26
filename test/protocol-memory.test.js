import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProtocolMemory } from "../src/protocol-memory.js";

test("protocol memory survives a restart and never stores the URL", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "protomem-")), "custom-protocols.json");
  const first = new ProtocolMemory({ file });
  first.set("custom-a|https://secret.example/v1|anthropic", "openai-chat");
  await first.writing;
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("secret.example"));
  const second = new ProtocolMemory({ file });
  assert.equal(second.get("custom-a|https://secret.example/v1|anthropic"), "openai-chat");
  second.delete("custom-a|https://secret.example/v1|anthropic");
  await second.writing;
  assert.equal(new ProtocolMemory({ file }).get("custom-a|https://secret.example/v1|anthropic"), null);
});
