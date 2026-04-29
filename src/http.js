export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readJson(req, { maxBodyBytes }) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBodyBytes) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(Object.assign(error, { statusCode: 400 }));
      }
    });

    req.on("error", reject);
  });
}

export function requireBearerToken(req, apiToken) {
  if (!apiToken) {
    return true;
  }

  return req.headers.authorization === `Bearer ${apiToken}`;
}
