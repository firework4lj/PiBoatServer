import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export class HeartbeatStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.historyPath = path.join(dataDir, "heartbeats.jsonl");
    this.latestPath = path.join(dataDir, "latest.json");
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
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
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
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
