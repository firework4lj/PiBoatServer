import { readBody, readJson, requireBearerToken, sendJson } from "./http.js";
import { normalizeHeartbeat, validateHeartbeat } from "./heartbeat.js";
import { sendStatic } from "./static.js";

const liveCameraSessions = new Map();
const LIVE_CAMERA_DURATION_MS = 5 * 60 * 1000;
const LIVE_CAMERA_INTERVAL_SECONDS = 2;

export function createRouter({ config, store }) {
  return async function route(req, res) {
    const url = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && await sendStatic(res, url.pathname)) {
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/heartbeat") {
        await handleHeartbeat(req, res, { config, store });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/snapshot") {
        await handleSnapshot(req, res, { config, store });
        return;
      }

      const liveStartMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/live\/start$/);
      if (req.method === "POST" && liveStartMatch) {
        const boatId = decodeURIComponent(liveStartMatch[1]);
        sendJson(res, 202, startLiveCamera(boatId));
        return;
      }

      const liveStopMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/live\/stop$/);
      if (req.method === "POST" && liveStopMatch) {
        const boatId = decodeURIComponent(liveStopMatch[1]);
        liveCameraSessions.delete(boatId);
        sendJson(res, 202, { active: false });
        return;
      }

      const liveStatusMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/live$/);
      if (req.method === "GET" && liveStatusMatch) {
        const boatId = decodeURIComponent(liveStatusMatch[1]);
        sendJson(res, 200, liveCameraStatus(boatId));
        return;
      }

      const latestMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/latest$/);
      if (req.method === "GET" && latestMatch) {
        const boatId = decodeURIComponent(latestMatch[1]);
        sendJson(res, 200, { boat_id: boatId, devices: await store.latestForBoat(boatId) });
        return;
      }

      const historyMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/history$/);
      if (req.method === "GET" && historyMatch) {
        const boatId = decodeURIComponent(historyMatch[1]);
        const limit = url.searchParams.get("limit") || 100;
        sendJson(res, 200, { boat_id: boatId, heartbeats: await store.historyForBoat(boatId, limit) });
        return;
      }

      const snapshotLatestMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/snapshot\/latest$/);
      if (req.method === "GET" && snapshotLatestMatch) {
        const boatId = decodeURIComponent(snapshotLatestMatch[1]);
        sendJson(res, 200, { boat_id: boatId, snapshot: await store.latestSnapshotForBoat(boatId) });
        return;
      }

      const snapshotImageMatch = url.pathname.match(/^\/api\/boats\/([^/]+)\/devices\/([^/]+)\/snapshot\.jpg$/);
      if (req.method === "GET" && snapshotImageMatch) {
        const boatId = decodeURIComponent(snapshotImageMatch[1]);
        const deviceId = decodeURIComponent(snapshotImageMatch[2]);
        const image = await store.snapshotImage(boatId, deviceId);
        if (!image) {
          sendJson(res, 404, { error: "snapshot not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": image.length,
          "Cache-Control": "no-cache",
        });
        res.end(image);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/boats") {
        sendJson(res, 200, { boats: await store.listBoats() });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: "internal server error" });
    }
  };
}

async function handleSnapshot(req, res, { config, store }) {
  if (!requireBearerToken(req, config.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (!req.headers["content-type"]?.startsWith("image/jpeg")) {
    sendJson(res, 415, { error: "snapshot must be image/jpeg" });
    return;
  }

  const boatId = req.headers["x-boat-id"];
  const deviceId = req.headers["x-device-id"];
  const sentAt = req.headers["x-sent-at"];
  if (!boatId || !deviceId || !sentAt || Number.isNaN(Date.parse(sentAt))) {
    sendJson(res, 400, { error: "snapshot metadata headers are required" });
    return;
  }

  let image;
  try {
    image = await readBody(req, { maxBodyBytes: config.maxSnapshotBytes });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || "invalid snapshot body" });
    return;
  }

  const metadata = await store.saveSnapshot({
    boatId,
    deviceId,
    sentAt,
    receivedAt: new Date().toISOString(),
    image,
  });

  console.log(
    JSON.stringify({
      event: "snapshot.received",
      boat_id: boatId,
      device_id: deviceId,
      bytes: image.length,
      received_at: metadata.received_at,
    }),
  );

  sendJson(res, 202, { status: "accepted", snapshot: metadata });
}

async function handleHeartbeat(req, res, { config, store }) {
  if (!requireBearerToken(req, config.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  let payload;
  try {
    payload = await readJson(req, { maxBodyBytes: config.maxBodyBytes });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || "invalid json" });
    return;
  }

  const errors = validateHeartbeat(payload);
  if (errors.length > 0) {
    sendJson(res, 400, { error: "invalid heartbeat payload", details: errors });
    return;
  }

  const heartbeat = normalizeHeartbeat(payload);
  await store.save(heartbeat);
  const liveCamera = liveCameraStatus(heartbeat.boat_id);

  console.log(
    JSON.stringify({
      event: "heartbeat.received",
      boat_id: heartbeat.boat_id,
      device_id: heartbeat.device_id,
      sequence: heartbeat.sequence,
      status: heartbeat.status,
      received_at: heartbeat.received_at,
    }),
  );

  sendJson(res, 202, {
    status: "accepted",
    commands: {
      camera_live: {
        active: liveCamera.active,
        interval_seconds: liveCamera.interval_seconds,
        until: liveCamera.until,
      },
    },
  });
}

function startLiveCamera(boatId) {
  const untilMs = Date.now() + LIVE_CAMERA_DURATION_MS;
  liveCameraSessions.set(boatId, untilMs);
  return liveCameraStatus(boatId);
}

function liveCameraStatus(boatId) {
  const untilMs = liveCameraSessions.get(boatId);
  if (!untilMs || untilMs <= Date.now()) {
    liveCameraSessions.delete(boatId);
    return {
      active: false,
      interval_seconds: null,
      until: null,
    };
  }

  return {
    active: true,
    interval_seconds: LIVE_CAMERA_INTERVAL_SECONDS,
    until: new Date(untilMs).toISOString(),
  };
}
