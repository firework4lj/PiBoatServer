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

test("deleteHistoryRangeForBoat removes one boat range and rebuilds latest", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "piboatserver-store-"));
  const store = new HeartbeatStore(dataDir);
  await store.init();

  try {
    await store.save(testHeartbeat("boat", "pi", 1, "2026-05-10T10:00:00Z"));
    await store.save(testHeartbeat("boat", "pi", 2, "2026-05-10T11:00:00Z"));
    await store.save(testHeartbeat("other", "pi", 1, "2026-05-10T11:30:00Z"));
    await store.save(testHeartbeat("boat", "pi", 3, "2026-05-11T10:00:00Z"));

    const result = await store.deleteHistoryRangeForBoat(
      "boat",
      "2026-05-10T00:00:00Z",
      "2026-05-11T00:00:00Z",
    );

    const boatHistory = await store.historyForBoat("boat", 10);
    const otherHistory = await store.historyForBoat("other", 10);
    const latest = await store.latestForBoat("boat");

    assert.equal(result.deleted, 2);
    assert.equal(boatHistory.length, 1);
    assert.equal(boatHistory[0].sequence, 3);
    assert.equal(otherHistory.length, 1);
    assert.equal(latest.pi.sequence, 3);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("saveAudioEvent stores recent event metadata and wav bytes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "piboatserver-store-"));
  const store = new HeartbeatStore(dataDir);
  await store.init();

  try {
    await store.save(testHeartbeat("boat", "pi", 1, "2026-05-10T10:00:00Z"));
    const metadata = await store.saveAudioEvent({
      boatId: "boat",
      deviceId: "pi",
      sentAt: "2026-05-10T10:00:01Z",
      receivedAt: "2026-05-10T10:00:02Z",
      trigger: "impact",
      rmsDb: "-22.9",
      peakDb: "-3.2",
      peakOverRmsDb: "19.7",
      durationSeconds: "10",
      audio: Buffer.from("RIFF-test"),
    });

    await store.saveAudioEventSnapshot({
      boatId: "boat",
      deviceId: "pi",
      eventId: metadata.event_id,
      sentAt: "2026-05-10T10:00:03Z",
      receivedAt: "2026-05-10T10:00:04Z",
      image: Buffer.from("jpeg-test"),
    });

    const events = await store.recentAudioEventsForBoat("boat", 10);
    const audio = await store.audioEventFile("boat", "pi", metadata.audio_url.match(/audio\/([^/]+)\.wav$/)[1]);
    const image = await store.audioEventImage("boat", "pi", metadata.event_id);

    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, "impact");
    assert.equal(events[0].rms_db, -22.9);
    assert.equal(events[0].bytes, 9);
    assert.equal(events[0].image_bytes, 9);
    assert(events[0].image_url.endsWith(".jpg"));
    assert.deepEqual(audio, Buffer.from("RIFF-test"));
    assert.deepEqual(image, Buffer.from("jpeg-test"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function testHeartbeat(boatId, deviceId, sequence, timestamp) {
  return {
    boat_id: boatId,
    device_id: deviceId,
    sequence,
    sent_at: timestamp,
    received_at: timestamp,
    status: "ok",
    sensors: {
      sim7600: {
        gnss: {
          fix: true,
          latitude: 45.5 + sequence / 1000,
          longitude: -122.7,
          speed_knots: 2,
        },
      },
    },
  };
}
