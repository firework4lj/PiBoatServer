import { readJson, requireBearerToken, sendJson } from "./http.js";
import { normalizeHeartbeat, validateHeartbeat } from "./heartbeat.js";
import { sendStatic } from "./static.js";

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

  sendJson(res, 202, { status: "accepted" });
}
