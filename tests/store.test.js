import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HeartbeatStore } from "../src/store.js";

test("historyForBoat can return seven days of 30 second heartbeats", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "piboatserver-store-"));
  const store = new HeartbeatStore(dataDir);
  await store.init();

  try {
    const start = new Date("2026-05-10T00:00:00Z");
    const heartbeatCount = 7 * 24 * 60 * 2;
    for (let index = 0; index < heartbeatCount; index += 1) {
      const timestamp = new Date(start.getTime() + index * 30 * 1000).toISOString();
      await store.save({
        boat_id: "boat",
        device_id: "pi",
        sequence: index + 1,
        sent_at: timestamp,
        received_at: timestamp,
        status: "ok",
        sensors: {
          arduino_voltage: {
            status: "ok",
            voltage: 12.7,
            charging: false,
            soc_estimate_percent: 100,
          },
        },
      });
    }

    const history = await store.historyForBoat("boat", 21000);

    assert.equal(history.length, heartbeatCount);
    assert.equal(history[0].sequence, heartbeatCount);
    assert.equal(history.at(-1).sequence, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
