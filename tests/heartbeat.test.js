import test from "node:test";
import assert from "node:assert/strict";

import { normalizeHeartbeat, validateHeartbeat } from "../src/heartbeat.js";

test("validateHeartbeat accepts PiBoatCore payloads", () => {
  const errors = validateHeartbeat({
    boat_id: "my-boat",
    device_id: "raspberry-pi-bridge",
    sequence: 1,
    sent_at: "2026-04-28T12:00:00Z",
    status: "ok",
    sensors: {
      gps: { status: "ok" },
    },
  });

  assert.deepEqual(errors, []);
});

test("validateHeartbeat reports missing required fields", () => {
  const errors = validateHeartbeat({});

  assert(errors.includes("boat_id is required"));
  assert(errors.includes("device_id is required"));
  assert(errors.includes("sent_at must be an ISO timestamp"));
  assert(errors.includes("sensors must be an object"));
});

test("normalizeHeartbeat trims ids and adds received_at", () => {
  const heartbeat = normalizeHeartbeat(
    {
      boat_id: " my-boat ",
      device_id: " pi ",
      sent_at: "2026-04-28T12:00:00Z",
      sensors: {},
    },
    new Date("2026-04-28T12:01:00Z"),
  );

  assert.equal(heartbeat.boat_id, "my-boat");
  assert.equal(heartbeat.device_id, "pi");
  assert.equal(heartbeat.received_at, "2026-04-28T12:01:00.000Z");
});
