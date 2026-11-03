#!/usr/bin/env node
// WebMCP -> MCP bridge: drives a Chrome tab with WebMCP enabled and re-exposes
// the tools the page registers (document.modelContext) as native MCP tools over stdio.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright-core";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : process.env[`WEBMCP_${name.toUpperCase().replace(/-/g, "_")}`] ?? def;
};
const flag = (name) => argv.includes(`--${name}`);
const log = (...a) => console.error("[webmcp-bridge]", ...a); // stdout is the MCP channel

const URL_ = opt("url", "http://localhost:8000");
const CDP = opt("cdp");                // e.g. http://127.0.0.1:9222 to attach to an existing Chrome
const CHROME = opt("chrome", process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const HEADLESS = flag("headless");
const SHOT_DIR = opt("screenshot-dir", os.tmpdir());

let browser, context, page;

async function connect() {
  if (CDP) {
    browser = await chromium.connectOverCDP(CDP);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "webmcp-bridge-"));
    context = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME,
      headless: HEADLESS,
      viewport: null,
      args: ["--enable-features=WebMCPTesting", "--no-first-run", "--no-default-browser-check"],
    });
  }
  // The page tells us when its tool set changes.
  await context.exposeBinding("__webmcpBridgeToolsChanged", () => notifyChanged());
  await context.addInitScript(() => {
    const hook = () => {
      const mc = document.modelContext;
      if (mc && !mc.__bridgeHooked) {
        mc.__bridgeHooked = true;
        mc.addEventListener?.("toolchange", () => window.__webmcpBridgeToolsChanged?.());
      }
    };
    hook();
    document.addEventListener("DOMContentLoaded", hook);
  });
  page = context.pages().find((p) => p.url().startsWith(URL_)) ?? context.pages()[0] ?? (await context.newPage());
  page.on("load", () => notifyChanged());
  if (!page.url().startsWith(URL_)) await page.goto(URL_);
  log("attached to", page.url());
}

async function pageTools() {
  return page.evaluate(() => {
    const mc = document.modelContext;
    if (!mc?.getTools) return { error: "document.modelContext unavailable (is Chrome launched with --enable-features=WebMCPTesting?)" };
    return Promise.resolve(mc.getTools()).then((tools) =>
      tools.map((t) => {
        let schema = t.inputSchema;
        if (typeof schema === "string") { try { schema = JSON.parse(schema); } catch { schema = undefined; } }
        return { name: t.name, description: t.description ?? "", inputSchema: schema };
      }));
  });
}

let server;
let pending;
function notifyChanged() {
  clearTimeout(pending); // debounce bursts of registerTool calls
  pending = setTimeout(() => server?.sendToolListChanged().catch(() => {}), 200);
}

const BUILTIN = {
  name: "webmcp_bridge_screenshot",
  description: "Bridge helper (not a page tool): save a PNG screenshot of the bridged tab and return its path.",
  inputSchema: { type: "object", properties: { path: { type: "string", description: "optional output path" } } },
};

server = new Server({ name: "webmcp-bridge", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await pageTools();
  if (tools.error) { log(tools.error); return { tools: [BUILTIN] }; }
  return {
    tools: [
      ...tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema?.type === "object" ? t.inputSchema : { type: "object", properties: {} },
      })),
      BUILTIN,
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const { name, arguments: args = {} } = params;
  if (name === BUILTIN.name) {
    const p = args.path || path.join(SHOT_DIR, `webmcp-${Date.now()}.png`);
    await page.screenshot({ path: p });
    return { content: [{ type: "text", text: p }] };
  }
  const r = await page.evaluate(async ({ name, args }) => {
    const mc = document.modelContext;
    const tool = (await mc.getTools()).find((t) => t.name === name);
    if (!tool) return { error: `no WebMCP tool named ${name} on this page` };
    try { return { ok: await mc.executeTool(tool, args) }; } // takes the tool object + an args object
    catch (e) { return { error: String(e?.message ?? e) }; }
  }, { name, args });
  if (r.error) return { isError: true, content: [{ type: "text", text: r.error }] };
  // executeTool resolves to a JSON string; if it is already an MCP-style {content:[...]} result, pass it through.
  let v = r.ok;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch {} }
  if (v && Array.isArray(v.content)) return { content: v.content, isError: !!v.isError };
  return { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] };
});

await connect();
await server.connect(new StdioServerTransport());
const bye = async () => { try { CDP ? await browser.close() : await context.close(); } catch {} process.exit(0); };
process.stdin.on("close", bye);
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
