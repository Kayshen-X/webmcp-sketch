// WebMCP × sketch canvas — MIT. API per https://github.com/webmachinelearning/webmcp
const NS = "http://www.w3.org/2000/svg";
const layer = document.getElementById("shapes");
const logEl = document.getElementById("log");
let shapes = [], nextId = 1;
const TYPES = ["rect", "ellipse", "line", "text"];

function render() {
  layer.replaceChildren();
  for (const s of shapes) {
    let el;
    const stroke = s.stroke || "#2b2b2e";
    if (s.type === "rect") { el = document.createElementNS(NS, "rect"); Object.entries({x:s.x,y:s.y,width:s.w,height:s.h,rx:3}).forEach(([k,v])=>el.setAttribute(k,v)); }
    else if (s.type === "ellipse") { el = document.createElementNS(NS, "ellipse"); Object.entries({cx:s.x+s.w/2,cy:s.y+s.h/2,rx:s.w/2,ry:s.h/2}).forEach(([k,v])=>el.setAttribute(k,v)); }
    else if (s.type === "line") { el = document.createElementNS(NS, "line"); Object.entries({x1:s.x,y1:s.y,x2:s.x+s.w,y2:s.y+s.h}).forEach(([k,v])=>el.setAttribute(k,v)); }
    else { el = document.createElementNS(NS, "text"); el.setAttribute("x", s.x); el.setAttribute("y", s.y); el.setAttribute("font-size", s.size || 28); el.setAttribute("font-family", "Caveat, 'Comic Sans MS', cursive"); el.textContent = s.text || "note"; el.setAttribute("fill", stroke); }
    if (s.type !== "text") { el.setAttribute("fill", s.fill || "none"); el.setAttribute("stroke", stroke); el.setAttribute("stroke-width", s.strokeWidth || 2.2); el.setAttribute("stroke-linecap", "round"); }
    layer.appendChild(el);
  }
}
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const fail = (msg) => ({ content: [{ type: "text", text: "Error: " + msg }], isError: true });
const num = (v, d) => (v === undefined || v === "" || isNaN(+v)) ? d : +v;

// ---- Tool handlers (shared by WebMCP and the mock agent) ----
const handlers = {
  add_shape(a = {}) {
    if (!TYPES.includes(a.type)) return fail(`type must be one of ${TYPES.join(", ")}`);
    const s = { id: "s" + nextId++, type: a.type, x: num(a.x, 100), y: num(a.y, 100), w: num(a.w, 160), h: num(a.h, 100),
      text: a.text, stroke: a.stroke, fill: a.fill, strokeWidth: num(a.strokeWidth, 2.2), size: num(a.size, 28) };
    shapes.push(s); render(); return ok({ added: s });
  },
  list_shapes() { return ok({ count: shapes.length, shapes }); },
  update_shape(a = {}) {
    const s = shapes.find((x) => x.id === a.id);
    if (!s) return fail(`no shape with id "${a.id}". Call list_shapes first.`);
    for (const k of ["x","y","w","h","text","stroke","fill","strokeWidth","size"]) if (a[k] !== undefined) s[k] = a[k];
    render(); return ok({ updated: s });
  },
  clear_canvas() { const n = shapes.length; shapes = []; nextId = 1; render(); return ok({ removed: n }); },
};

const schemaProps = {
  type: { type: "string", enum: TYPES, description: "Shape kind" },
  x: { type: "number", description: "Left / start X in canvas units (0-800)" },
  y: { type: "number", description: "Top / start Y (or text baseline) in canvas units (0-560)" },
  w: { type: "number", description: "Width (for line: delta X)" },
  h: { type: "number", description: "Height (for line: delta Y)" },
  text: { type: "string", description: "Text content when type is text" },
  stroke: { type: "string", description: "CSS stroke color, default graphite #2b2b2e" },
  fill: { type: "string", description: "CSS fill color or 'none'" },
};
const tools = [
  { name: "add_shape", description: "Add a shape (rect, ellipse, line, text) to the user's sketch canvas. Returns the new shape with its id.",
    inputSchema: { type: "object", properties: schemaProps, required: ["type"] } },
  { name: "list_shapes", description: "List all shapes currently on the sketch canvas, with ids and geometry.",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "update_shape", description: "Update properties of an existing shape by id (get ids from list_shapes).",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Shape id, e.g. s1" }, ...Object.fromEntries(Object.entries(schemaProps).filter(([k]) => k !== "type")) }, required: ["id"] } },
  { name: "clear_canvas", description: "Remove every shape from the sketch canvas. Destructive.",
    inputSchema: { type: "object", properties: {} } },
];

function log(name, args, result, src) {
  const d = document.createElement("div"); d.className = "e";
  d.innerHTML = `<div><span class="t"></span> <span class="src"></span></div><pre></pre>`;
  d.querySelector(".t").textContent = `${name}(${JSON.stringify(args ?? {})})`;
  d.querySelector(".src").textContent = "· " + src;
  d.querySelector("pre").textContent = "→ " + (result.content?.[0]?.text ?? "").slice(0, 160);
  logEl.prepend(d);
}
async function call(name, args, src) { const r = await handlers[name](args); log(name, args, r, src); return r; }

// ---- Feature detection + WebMCP registration (imperative) ----
const mc = document.modelContext; // current explainer location
const status = document.getElementById("status");
if (mc && typeof mc.registerTool === "function") {
  status.textContent = "WebMCP: available"; status.classList.add("on");
  const controller = new AbortController();
  for (const t of tools) {
    try {
      await mc.registerTool({ ...t, execute: (args) => call(t.name, args, "agent via WebMCP") }, { signal: controller.signal });
    } catch (e) { console.warn("registerTool failed", t.name, e); }
  }
  window.addEventListener("pagehide", () => controller.abort());
} else {
  status.textContent = "WebMCP: unavailable → mock agent";
  document.getElementById("banner").style.display = "block";
}

// ---- Declarative form tool (Chrome declarative API: toolname / tooldescription) ----
document.getElementById("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const r = await call("add_shape", { type: f.type, text: f.text || undefined, x: +f.x, y: +f.y }, e.agentInvoked ? "agent via declarative form" : "user via form");
  if (e.agentInvoked && e.respondWith) e.respondWith(Promise.resolve(r.content[0].text));
});

// ---- Mock agent panel ----
const sel = document.getElementById("tool"), argsEl = document.getElementById("args");
const samples = { add_shape: { type: "ellipse", x: 300, y: 200, w: 180, h: 120 }, list_shapes: {}, update_shape: { id: "s1", stroke: "#c9a227" }, clear_canvas: {} };
for (const t of tools) sel.add(new Option(t.name, t.name));
const fill = () => (argsEl.value = JSON.stringify(samples[sel.value], null, 1));
sel.onchange = fill; fill();
document.getElementById("run").onclick = () => { try { call(sel.value, JSON.parse(argsEl.value || "{}"), "mock agent"); } catch (e) { log(sel.value, {}, fail("bad JSON"), "mock agent"); } };
const script = [
  ["clear_canvas", {}],
  ["add_shape", { type: "rect", x: 90, y: 90, w: 260, h: 170 }],
  ["add_shape", { type: "ellipse", x: 430, y: 120, w: 220, h: 150 }],
  ["add_shape", { type: "line", x: 350, y: 175, w: 80, h: 20 }],
  ["add_shape", { type: "text", x: 120, y: 330, text: "MCP = call center", size: 30 }],
  ["add_shape", { type: "text", x: 430, y: 330, text: "WebMCP = in-store expert", size: 30 }],
  ["add_shape", { type: "rect", x: 90, y: 380, w: 560, h: 110, fill: "rgba(201,162,39,.12)" }],
  ["update_shape", { id: "s2", stroke: "#b8901a", strokeWidth: 3 }],
  ["list_shapes", {}],
];
async function viaAgent(n, a) {
  // Real WebMCP path: discover tools like an agent would, then invoke through the browser.
  const t = (await mc.getTools()).find((x) => x.name === n);
  return mc.executeTool(t, a);
}
const useWebMCP = () => mc && typeof mc.executeTool === "function" && !new URLSearchParams(location.search).has("mock");
async function runScript() { for (const [n, a] of script) { if (useWebMCP()) await viaAgent(n, a); else await call(n, a, "mock agent"); await new Promise((r) => setTimeout(r, +(new URLSearchParams(location.search).get('step') || 120))); } }
document.getElementById("demo").onclick = runScript;
if (new URLSearchParams(location.search).has("autoplay")) setTimeout(runScript, +(new URLSearchParams(location.search).get("delay") || 0));
