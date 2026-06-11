const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8787;
const STORE_FILE = path.join(__dirname, "naomi-ceramics-new.html");
const BACKUP_DIR = path.join(__dirname, "naomi-store-backups");
const MIN_STORE_BYTES = 250_000;
const MIN_PAGE_BYTES = {
  home: 100_000,
  about: 20_000,
  faq: 20_000,
  materials: 30_000
};

function isEditorSource(source) {
  const text = String(source || "");
  return text.includes("naomi-store-editor")
    || text.includes("עורך החנות")
    || text.includes("panel-visual")
    || text.includes("SOURCE_STORAGE_KEY")
    || text.includes("STORE_FILE_HANDLE_KEY");
}

function isValidStoreSource(source) {
  const text = String(source || "");
  if (typeof source !== "string") return false;
  if (source.length < MIN_STORE_BYTES) return false;
  if (!/^\s*<!DOCTYPE html>\s*<html lang="he" dir="rtl">/i.test(text)) return false;
  if (!/<title>נעמי גולדמן \| האתר המלא בקובץ אחד<\/title>/.test(text)) return false;
  if (!/<iframe[^>]+id=["']site-frame["']/i.test(text)) return false;
  if (!text.includes("const PAGES =") || !text.includes("const PAGE_TITLES") || !text.includes("function loadPage")) return false;
  if (isEditorSource(text)) return false;
  try {
    const match = text.match(/const PAGES = (.*);\nconst PAGE_TITLES/s);
    if (!match) return false;
    if (/<\/script/i.test(match[1])) return false;
    const pages = JSON.parse(match[1]);
    for (const [key, minBytes] of Object.entries(MIN_PAGE_BYTES)) {
      const page = pages[key];
      if (typeof page !== "string") return false;
      if (page.length < minBytes) return false;
      if (!page.includes("<!DOCTYPE html>")) return false;
      if (page.includes("data-visual-id") || page.includes("data-visual-selected")) return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function serializePagesForScript(pages) {
  return JSON.stringify(pages).replace(/<\/script/gi, "<\\/script");
}

function extractPages(source) {
  const match = String(source || "").match(/const PAGES = (.*);\nconst PAGE_TITLES/s);
  if (!match) throw new Error("PAGES block not found");
  return JSON.parse(match[1]);
}

function replacePages(source, pages) {
  const nextPages = `const PAGES = ${serializePagesForScript(pages)};\nconst PAGE_TITLES`;
  const next = String(source || "").replace(/const PAGES = .*;\nconst PAGE_TITLES/s, nextPages);
  if (next === source) throw new Error("Could not replace PAGES block");
  return next;
}

function isValidPageHtml(pageKey, pageHtml) {
  const minBytes = MIN_PAGE_BYTES[pageKey];
  if (!minBytes) return false;
  if (typeof pageHtml !== "string") return false;
  if (pageHtml.length < minBytes) return false;
  if (!pageHtml.includes("<!DOCTYPE html>")) return false;
  if (pageHtml.includes("data-visual-id") || pageHtml.includes("data-visual-selected")) return false;
  if (isEditorSource(pageHtml)) return false;
  return true;
}

function atomicWriteStore(html) {
  if (!isValidStoreSource(html)) {
    throw new Error("Refusing to write invalid store HTML");
  }

  const current = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, "utf8") : "";
  if (current && !isValidStoreSource(current)) {
    throw new Error("Target file is not the Naomi store file");
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (current) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `${path.basename(STORE_FILE, ".html")}-before-${stamp}.html`;
    fs.writeFileSync(path.join(BACKUP_DIR, backupName), current);
  }

  const tempFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tempFile, html);
  const tempVerified = fs.readFileSync(tempFile, "utf8");
  if (tempVerified !== html || !isValidStoreSource(tempVerified)) {
    fs.rmSync(tempFile, { force: true });
    throw new Error("Temporary write verification failed; target was not changed");
  }

  fs.renameSync(tempFile, STORE_FILE);
  const verified = fs.readFileSync(STORE_FILE, "utf8");
  if (verified !== html || !isValidStoreSource(verified)) {
    throw new Error("Final write verification failed");
  }
  return verified;
}

function send(res, status, data) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  if (req.url === "/health") return send(res, 200, { ok: true, file: STORE_FILE });
  if (req.url === "/store" && req.method === "GET") {
    try {
      const html = fs.readFileSync(STORE_FILE, "utf8");
      if (!isValidStoreSource(html)) return send(res, 400, { ok: false, error: "Store file is invalid" });
      return send(res, 200, { ok: true, file: STORE_FILE, html });
    } catch (error) {
      return send(res, 500, { ok: false, error: error.message || "Could not read store file" });
    }
  }
  if (req.url === "/save-page" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const pageKey = String(payload.pageKey || "");
      const pageHtml = String(payload.pageHtml || "");

      if (!isValidPageHtml(pageKey, pageHtml)) {
        return send(res, 400, { ok: false, error: "Edited page HTML is not valid enough to save" });
      }

      const current = fs.readFileSync(STORE_FILE, "utf8");
      if (!isValidStoreSource(current)) {
        return send(res, 400, { ok: false, error: "Target file is not valid; not changing it" });
      }
      const pages = extractPages(current);
      pages[pageKey] = pageHtml;
      const next = replacePages(current, pages);
      const verified = atomicWriteStore(next);
      return send(res, 200, { ok: true, file: STORE_FILE, bytes: verified.length });
    } catch (error) {
      return send(res, 500, { ok: false, error: error.message || "Page save failed" });
    }
  }

  if (req.url !== "/save" || req.method !== "POST") return send(res, 404, { ok: false, error: "Not found" });

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const html = String(payload.html || "");

    if (!isValidStoreSource(html)) {
      return send(res, 400, { ok: false, error: "HTML is not a valid Naomi store file" });
    }

    const verified = atomicWriteStore(html);

    send(res, 200, { ok: true, file: STORE_FILE, bytes: verified.length });
  } catch (error) {
    send(res, 500, { ok: false, error: error.message || "Save failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Naomi save server running at http://127.0.0.1:${PORT}`);
  console.log(`Writing store file: ${STORE_FILE}`);
});
