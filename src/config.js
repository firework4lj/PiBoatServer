export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || "0.0.0.0",
    dataDir: env.DATA_DIR || "./data",
    maxBodyBytes: Number(env.MAX_BODY_BYTES || 262144),
    maxSnapshotBytes: Number(env.MAX_SNAPSHOT_BYTES || 524288),
    apiToken: env.API_TOKEN || "",
  };
}
