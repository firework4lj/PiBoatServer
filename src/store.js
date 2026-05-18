import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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
    this.audioDir = path.join(dataDir, "audio");
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.snapshotDir, { recursive: true });
    await mkdir(this.audioDir, { recursive: true });
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

  async deleteHistoryRangeForBoat(boatId, start, end) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (!boatId || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw new Error("invalid history deletion range");
    }

    let lines;
    try {
      lines = (await readFile(this.historyPath, "utf8")).split("\n");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { deleted: 0 };
      }
      throw error;
    }

    let deleted = 0;
    const keptRecords = [];
    const keptLines = [];

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const record = JSON.parse(line);
      const timestamp = new Date(record.received_at || record.sent_at).getTime();
      const shouldDelete = record.boat_id === boatId &&
        Number.isFinite(timestamp) &&
        timestamp >= startMs &&
        timestamp < endMs;

      if (shouldDelete) {
        deleted += 1;
      } else {
        keptRecords.push(record);
        keptLines.push(JSON.stringify(record));
      }
    }

    const tmpHistoryPath = `${this.historyPath}.tmp`;
    await writeFile(tmpHistoryPath, keptLines.length ? `${keptLines.join("\n")}\n` : "");
    await rename(tmpHistoryPath, this.historyPath);
    await this.#writeLatest(this.#latestFromRecords(keptRecords));

    return { deleted };
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

  async saveAudioEvent({ boatId, deviceId, sentAt, receivedAt, trigger, rmsDb, peakDb, peakOverRmsDb, durationSeconds, audio }) {
    const directory = path.join(this.audioDir, safePathPart(boatId), safePathPart(deviceId));
    await mkdir(directory, { recursive: true });

    const timestamp = safePathPart(receivedAt.replaceAll(":", "-"));
    const audioPath = path.join(directory, `${timestamp}.wav`);
    const metadataPath = path.join(directory, `${timestamp}.json`);
    const metadata = {
      event_id: timestamp,
      boat_id: boatId,
      device_id: deviceId,
      sent_at: sentAt,
      received_at: receivedAt,
      trigger,
      rms_db: numberOrNull(rmsDb),
      peak_db: numberOrNull(peakDb),
      peak_over_rms_db: numberOrNull(peakOverRmsDb),
      duration_seconds: numberOrNull(durationSeconds),
      bytes: audio.length,
      audio_url: `/api/boats/${encodeURIComponent(boatId)}/devices/${encodeURIComponent(deviceId)}/audio/${encodeURIComponent(timestamp)}.wav`,
      image_url: null,
    };

    await writeFile(audioPath, audio);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  async saveAudioEventSnapshot({ boatId, deviceId, eventId, sentAt, receivedAt, image }) {
    const directory = path.join(this.audioDir, safePathPart(boatId), safePathPart(deviceId));
    await mkdir(directory, { recursive: true });

    const safeEventId = safePathPart(eventId);
    const imagePath = path.join(directory, `${safeEventId}.jpg`);
    const metadataPath = path.join(directory, `${safeEventId}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.image_sent_at = sentAt;
    metadata.image_received_at = receivedAt;
    metadata.image_bytes = image.length;
    metadata.image_url = `/api/boats/${encodeURIComponent(boatId)}/devices/${encodeURIComponent(deviceId)}/audio/${encodeURIComponent(safeEventId)}.jpg`;

    await writeFile(imagePath, image);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  async recentAudioEventsForBoat(boatId, limit = 10) {
    const latest = await this.#loadLatest();
    const devices = Object.keys(latest[boatId] || {});
    const events = [];

    for (const deviceId of devices) {
      const directory = path.join(this.audioDir, safePathPart(boatId), safePathPart(deviceId));
      let files;
      try {
        files = await readdir(directory);
      } catch (error) {
        if (error.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      for (const file of files) {
        if (!file.endsWith(".json")) {
          continue;
        }
        events.push(JSON.parse(await readFile(path.join(directory, file), "utf8")));
      }
    }

    events.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    return events.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
  }

  async audioEventFile(boatId, deviceId, eventId) {
    const audioPath = path.join(this.audioDir, safePathPart(boatId), safePathPart(deviceId), `${safePathPart(eventId)}.wav`);
    try {
      return await readFile(audioPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async audioEventImage(boatId, deviceId, eventId) {
    const imagePath = path.join(this.audioDir, safePathPart(boatId), safePathPart(deviceId), `${safePathPart(eventId)}.jpg`);
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

  #latestFromRecords(records) {
    const latest = {};
    for (const record of records) {
      latest[record.boat_id] ||= {};
      latest[record.boat_id][record.device_id] = record;
    }
    return latest;
  }
}

function safePathPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
