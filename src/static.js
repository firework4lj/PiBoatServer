import { readFile } from "node:fs/promises";
import path from "node:path";

const PUBLIC_DIR = path.resolve("public");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export async function sendStatic(res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "forbidden");
    return true;
  }

  try {
    const contents = await readFile(filePath);
    const contentType = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": contents.length,
      "Cache-Control": "no-cache",
    });
    res.end(contents);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}
