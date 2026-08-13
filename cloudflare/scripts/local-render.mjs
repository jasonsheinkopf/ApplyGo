import http from "node:http";
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const port = Number(process.env.APPLYGO_RENDER_PORT || 8788);
const candidates = [
  process.env.APPLYGO_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));

if (!executablePath) {
  throw new Error("No local Chrome/Chromium found. Set APPLYGO_CHROME_PATH to its executable.");
}

let browserPromise;
function browser() {
  browserPromise ??= puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
  });
  return browserPromise;
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/render") {
    response.writeHead(404).end("not_found");
    return;
  }

  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 4_000_000) throw new Error("render_request_too_large");
    }
    const { html } = JSON.parse(body);
    if (typeof html !== "string" || !html) throw new Error("html_required");

    const page = await (await browser()).newPage();
    try {
      await page.setViewport({ width: 816, height: 1056 });
      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.emulateMediaType("print");
      const pdf = await page.pdf({
        format: "letter",
        printBackground: true,
        margin: { top: "0in", bottom: "0in", left: "0in", right: "0in" },
      });
      const screenshot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        pdf_base64: Buffer.from(pdf).toString("base64"),
        screenshot_base64: Buffer.from(screenshot).toString("base64"),
      }));
    } finally {
      await page.close();
    }
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ApplyGo local resume renderer: http://127.0.0.1:${port} (${executablePath})\n`);
});

async function shutdown() {
  server.close();
  if (browserPromise) await (await browserPromise).close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
