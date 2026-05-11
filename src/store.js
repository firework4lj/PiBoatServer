import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const MAX_HISTORY_RECORDS = 25000;

export class HeartbeatStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.historyPath = path.join(dataDir, "heartbeats.jsonl");
    this.latestPath = path.join(dataDir, "latest.json");
    this.snapshotDir = path.join(dataDir, "snapshots");
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.snapshotDir, { recursive: true });
    await this.#loadLatest();
  }

  async save(heartbeat) {
    await mkdir(this.dataDir, { recursive: true });

    const latest = await this.#loadLatest();
    latest[heartbeat.boat_id] ||= {};
    latest[heartbeat.boat_id][heartbeat.device_id] = heartbeat;

    await writeFile(this.historyPath, `${JSON.stringify(heartbeat)}\n`, { flag: "a" });
    await this.#writeLatest(latest);
  }

  async listBoats() {
    const latest = await this.#loadLatest();
    return Object.entries(latest).map(([boatId, devices]) => ({
      boat_id: boatId,
      devices: Object.keys(devices),
    }));
  }

  async latestForBoat(boatId) {
    const latest = await this.#loadLatest();
    return latest[boatId] || {};
  }

  async historyForBoat(boatId, limit = 100) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, MAX_HISTORY_RECORDS));
    const records = [];

    try {
      const input = createReadStream(this.historyPath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });

      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const record = JSON.parse(line);
        if (record.boat_id === boatId) {
          records.push(record);
          if (records.length > boundedLimit) {
            records.shift();
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    return records.reverse();
  }

  async saveSnapshot({ boatId, deviceId, sentAt, receivedAt, image }) {
    const directory = path.join(this.snapshotDir, safePathPart(boatId), safePathPart(deviceId));
    await mkdir(directory, { recursive: true });

    const imagePath = path.join(directory, "latest.jpg");
    const metadataPath = path.join(directory, "latest.json");
    const metadata = {
      boat_id: boatId,
      device_id: deviceId,
      sent_at: sentAt,
      received_at: receivedAt,
      bytes: image.length,
      image_url: `/api/boats/${encodeURIComponent(boatId)}/devices/${encodeURIComponent(deviceId)}/snapshot.jpg`,
    };

    await writeFile(imagePath, image);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  async latestSnapshotForBoat(boatId) {
    const latest = await this.#loadLatest();
    const devices = Object.keys(latest[boatId] || {});
    const snapshots = [];

    for (const deviceId of devices) {
      const metadata = await this.snapshotMetadata(boatId, deviceId);
      if (metadata) {
        snapshots.push(metadata);
      }
    }

    snapshots.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    return snapshots[0] || null;
  }

  async snapshotMetadata(boatId, deviceId) {
    const metadataPath = path.join(this.snapshotDir, safePathPart(boatId), safePathPart(deviceId), "latest.json");
    try {
      return JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async snapshotImage(boatId, deviceId) {
    const imagePath = path.join(this.snapshotDir, safePathPart(boatId), safePathPart(deviceId), "latest.jpg");
    try {
      return await readFile(imagePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async #loadLatest() {
    try {
      const contents = await readFile(this.latestPath, "utf8");
      return JSON.parse(contents);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async #writeLatest(latest) {
    const tmpPath = `${this.latestPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(latest, null, 2)}\n`);
    await rename(tmpPath, this.latestPath);
  }
}

function safePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}
