// Supper Rotation — a small home-network meal planner.
// No dependencies: needs Node 18+ (built-in fetch). Run `node server.js`.

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "supper.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const CATS = ["Chicken","Beef","Pork","Seafood","Pasta","Vegetarian","Soup & stew","Tacos & Mexican","Asian-inspired","Breakfast for dinner","Other"];
const EFFORTS = ["quick","medium","project"];

// ---------- storage ----------
const EXAMPLES = [
  ["Chicken fajitas","Tacos & Mexican","quick",true],
  ["Spaghetti & meatballs","Pasta","medium",true],
  ["Salmon, rice & broccoli","Seafood","quick",false],
  ["Beef chili","Soup & stew","medium",false],
  ["Teriyaki chicken bowls","Asian-inspired","quick",false],
  ["Homemade pizza night","Other","project",false],
  ["Pancakes & bacon","Breakfast for dinner","quick",false],
  ["Pot roast","Beef","project",false],
].map(([name, category, effort, favorite], i) => ({
  id: "ex-" + i, name, category, effort, favorite, notes: "", recipeUrl: "", recipe: null,
  lastCooked: null, timesCooked: 0, example: true, createdAt: i,
}));

let state = {
  version: 1,
  meals: EXAMPLES,
  plan: { days: {} },
  settings: {
    ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "",
  },
};

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    state = { ...state, ...saved, settings: { ...state.settings, ...(saved.settings || {}) } };
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Could not read data file, starting fresh:", e.message);
  }
}

let writing = Promise.resolve();
function persist() {
  state.version++;
  const body = JSON.stringify(state, null, 2);
  writing = writing.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, DATA_FILE);
  }).catch(e => console.error("Save failed:", e.message));
  broadcast();
}

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function broadcast() {
  for (const res of clients) res.write(`data: ${state.version}\n\n`);
}

// ---------- helpers ----------
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw new Error("Request too large"); chunks.push(c); }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
const str = (v, max) => String(v ?? "").trim().slice(0, max);

function cleanMeal(input, existing = {}) {
  const m = { ...existing };
  if ("name" in input) m.name = str(input.name, 80);
  if ("category" in input) m.category = CATS.includes(input.category) ? input.category : "Other";
  if ("effort" in input) m.effort = EFFORTS.includes(input.effort) ? input.effort : "medium";
  if ("notes" in input) m.notes = str(input.notes, 1000);
  if ("recipeUrl" in input) m.recipeUrl = /^https?:\/\//i.test(str(input.recipeUrl, 1000)) ? str(input.recipeUrl, 1000) : "";
  if ("favorite" in input) m.favorite = !!input.favorite;
  if ("example" in input) m.example = !!input.example;
  if ("lastCooked" in input) m.lastCooked = /^\d{4}-\d{2}-\d{2}$/.test(input.lastCooked) ? input.lastCooked : null;
  if ("timesCooked" in input) m.timesCooked = Math.max(0, Number(input.timesCooked) || 0);
  if ("recipe" in input) m.recipe = input.recipe && typeof input.recipe === "object" ? cleanRecipe(input.recipe) : null;
  return m;
}
function cleanRecipe(r) {
  const list = (a, n, max) => (Array.isArray(a) ? a : []).map(x => str(x, max)).filter(Boolean).slice(0, n);
  return {
    title: str(r.title, 200), image: /^https?:\/\//.test(r.image || "") ? str(r.image, 1000) : "",
    ingredients: list(r.ingredients, 80, 300), steps: list(r.steps, 60, 2000),
    totalTime: str(r.totalTime, 40), servings: str(r.servings, 40),
    source: str(r.source, 40), fetchedAt: r.fetchedAt || new Date().toISOString(),
  };
}

// ---------- recipe import (schema.org Recipe JSON-LD) ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", frac12: "½", frac14: "¼", frac34: "¾", deg: "°", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
function decode(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ").trim();
}
function isoDuration(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(d || ""));
  if (!m) return "";
  const mins = (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  if (!mins) return "";
  const h = Math.floor(mins / 60), mm = mins % 60;
  return [h ? `${h} hr` : "", mm ? `${mm} min` : ""].filter(Boolean).join(" ");
}
function findRecipe(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const t = node["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return node;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
    const r = findRecipe(node[k]); if (r) return r;
  }
  return null;
}
function flattenSteps(ins) {
  if (!ins) return [];
  if (typeof ins === "string") return ins.split(/\n+|(?<=\.)\s{2,}/).map(decode).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(flattenSteps);
  if (ins["@type"] === "HowToSection" || ins.itemListElement) {
    const head = ins.name ? [`— ${decode(ins.name)} —`] : [];
    return head.concat(flattenSteps(ins.itemListElement));
  }
  return [decode(ins.text || ins.name || "")].filter(Boolean);
}
function pickImage(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return pickImage(img[img.length - 1]);
  return img.url || img.contentUrl || "";
}
// Some sites reject browser-looking requests from scripts but accept a plainly
// identified reader, and others are the reverse, so try both.
const AGENTS = [
  "Mozilla/5.0 (compatible; SupperRotation/1.0; home recipe reader)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
];
async function importRecipe(url) {
  let res;
  for (const ua of AGENTS) {
    res = await fetch(url, {
      headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok || res.status === 404) break;
  }
  if (res.status === 404) throw new Error("That recipe page doesn't exist (404). Check the link.");
  if (!res.ok) throw new Error(`The recipe site answered ${res.status}. It may block apps from reading it; the link still works in a browser.`);
  const html = await res.text();
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let recipe = null;
  for (const b of blocks) {
    try { recipe = findRecipe(JSON.parse(b[1].trim())); } catch { /* skip bad block */ }
    if (recipe) break;
  }
  if (!recipe) throw new Error("Couldn't find a recipe on that page. The link still works in a browser.");
  const yieldVal = Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield;
  return cleanRecipe({
    title: decode(recipe.name),
    image: pickImage(recipe.image),
    ingredients: (recipe.recipeIngredient || recipe.ingredients || []).map(decode),
    steps: flattenSteps(recipe.recipeInstructions),
    totalTime: isoDuration(recipe.totalTime) || isoDuration(recipe.cookTime),
    servings: decode(yieldVal),
    source: "link",
  });
}

// ---------- Ollama ----------
function ollamaBase() { return state.settings.ollamaUrl.replace(/\/+$/, ""); }
async function ollamaModels() {
  const r = await fetch(ollamaBase() + "/api/tags", { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  const j = await r.json();
  return (j.models || []).map(m => m.name);
}
async function ollamaJson(prompt) {
  let model = state.settings.model;
  if (!model) {
    const models = await ollamaModels();
    if (!models.length) throw new Error("Ollama has no models installed. Run `ollama pull llama3.1` on that machine.");
    model = models[0];
  }
  const r = await fetch(ollamaBase() + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, format: "json", options: { temperature: 0.8 }, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`Ollama answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.message?.content || "";
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    if (m) return JSON.parse(m[0]);
    throw new Error("The model's answer wasn't valid JSON. Try again or pick a different model.");
  }
}
function ollamaError(e) {
  if (e.name === "TimeoutError") return "Ollama took too long to answer. A smaller model may be faster.";
  if (e.cause?.code === "ECONNREFUSED" || e.message === "fetch failed")
    return `Can't reach Ollama at ${state.settings.ollamaUrl}. Check the address in Settings, and that Ollama on that laptop is started with OLLAMA_HOST=0.0.0.0.`;
  return e.message;
}

async function suggestIdeas(nudge) {
  const known = state.meals.filter(m => !m.example)
    .map(m => `- ${m.name} (${m.category}${m.favorite ? ", favorite" : ""})`).join("\n") || "(none saved yet)";
  const prompt =
    `You help a married couple plan home-cooked dinners. Meals they already cook:\n${known}\n\n` +
    (nudge ? `What they're in the mood for: "${str(nudge, 300)}"\n\n` : "") +
    `Suggest 6 NEW dinner ideas they don't already have that fit their tastes, with variety, realistic for a home cook.\n` +
    `Respond with a JSON object: {"ideas": [{"name": string, "category": one of ${JSON.stringify(CATS)}, "effort": "quick" | "medium" | "project", "why": one sentence, "ingredients": [4-7 key ingredients]}]}`;
  const out = await ollamaJson(prompt);
  const list = Array.isArray(out) ? out : Array.isArray(out.ideas) ? out.ideas : Object.values(out).find(Array.isArray) || [];
  const have = new Set(state.meals.map(m => m.name.toLowerCase()));
  return list.filter(x => x && x.name).slice(0, 8).map(x => ({
    name: str(x.name, 80),
    category: CATS.includes(x.category) ? x.category : "Other",
    effort: EFFORTS.includes(x.effort) ? x.effort : "medium",
    why: str(x.why, 300),
    ingredients: (Array.isArray(x.ingredients) ? x.ingredients : []).map(i => str(i, 80)).filter(Boolean).slice(0, 8),
    onList: have.has(str(x.name, 80).toLowerCase()),
  }));
}
async function writeRecipe(name, hint) {
  const prompt =
    `Write a clear home-cooking recipe for "${str(name, 80)}" that serves 2-4.` + (hint ? ` Context: ${str(hint, 300)}.` : "") +
    `\nRespond with a JSON object: {"title": string, "servings": string, "totalTime": string like "40 min", "ingredients": [strings with amounts], "steps": [strings, one action each]}`;
  const r = await ollamaJson(prompt);
  return cleanRecipe({ ...r, source: "ollama" });
}

// ---------- routes ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${state.version}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (p === "/api/state" && m === "GET") return send(res, 200, state);

  if (p === "/api/meals" && m === "POST") {
    const b = await readBody(req);
    const meal = cleanMeal({ favorite: false, notes: "", recipeUrl: "", recipe: null, lastCooked: null, timesCooked: 0, example: false, category: "Other", effort: "medium", ...b });
    if (!meal.name) return send(res, 400, { error: "Give the meal a name." });
    if (state.meals.some(x => x.name.toLowerCase() === meal.name.toLowerCase())) return send(res, 409, { error: "That meal is already on the list." });
    meal.id = crypto.randomUUID(); meal.createdAt = Date.now();
    state.meals.push(meal); persist();
    return send(res, 201, meal);
  }
  const mm = p.match(/^\/api\/meals\/([\w-]+)$/);
  if (mm) {
    const i = state.meals.findIndex(x => x.id === mm[1]);
    if (i < 0) return send(res, 404, { error: "That meal no longer exists." });
    if (m === "PATCH") {
      const b = await readBody(req);
      const before = state.meals[i];
      const next = cleanMeal(b, before);
      if (!next.name) return send(res, 400, { error: "Give the meal a name." });
      if ("recipeUrl" in b && next.recipeUrl !== before.recipeUrl && before.recipe?.source === "link") next.recipe = null;
      state.meals[i] = next; persist();
      return send(res, 200, next);
    }
    if (m === "DELETE") {
      const [gone] = state.meals.splice(i, 1);
      for (const d of Object.keys(state.plan.days)) if (state.plan.days[d].mealId === gone.id) delete state.plan.days[d];
      persist();
      return send(res, 200, { ok: true });
    }
  }
  const rm = p.match(/^\/api\/meals\/([\w-]+)\/recipe$/);
  if (rm && m === "POST") {
    const meal = state.meals.find(x => x.id === rm[1]);
    if (!meal) return send(res, 404, { error: "That meal no longer exists." });
    const b = await readBody(req);
    try {
      const recipe = b.mode === "ollama" ? await writeRecipe(meal.name, meal.notes) : await importRecipe(meal.recipeUrl);
      meal.recipe = recipe; persist();
      return send(res, 200, meal);
    } catch (e) {
      return send(res, 502, { error: b.mode === "ollama" ? ollamaError(e) : (e.name === "TimeoutError" ? "The recipe site took too long to answer." : e.message) });
    }
  }
  if (p === "/api/plan" && m === "PUT") {
    const b = await readBody(req);
    const days = {};
    for (const [k, v] of Object.entries(b.days || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v) continue;
      days[k] = { mealId: v.mealId ? String(v.mealId) : null, status: v.status === "cooked" ? "cooked" : "planned", pinned: !!v.pinned };
    }
    state.plan = { days }; persist();
    return send(res, 200, state.plan);
  }
  if (p === "/api/settings" && m === "PUT") {
    const b = await readBody(req);
    if ("ollamaUrl" in b) {
      let u = str(b.ollamaUrl, 300);
      if (u && !/^https?:\/\//i.test(u)) u = "http://" + u;
      if (u && !/:\d+(\/|$)/.test(u.replace(/^https?:\/\//, ""))) u = u.replace(/\/+$/, "") + ":11434";
      state.settings.ollamaUrl = u || "http://localhost:11434";
    }
    if ("model" in b) state.settings.model = str(b.model, 200);
    persist();
    return send(res, 200, state.settings);
  }
  if (p === "/api/ollama/models" && m === "GET") {
    try { return send(res, 200, { models: await ollamaModels() }); }
    catch (e) { return send(res, 502, { error: ollamaError(e) }); }
  }
  if (p === "/api/ideas" && m === "POST") {
    const b = await readBody(req);
    try { return send(res, 200, { ideas: await suggestIdeas(b.nudge) }); }
    catch (e) { return send(res, 502, { error: ollamaError(e) }); }
  }
  if (p.startsWith("/api/")) return send(res, 404, { error: "Not found" });

  // static files
  const file = path.normalize(path.join(PUBLIC_DIR, p === "/" ? "index.html" : p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

load();
http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) send(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? "Bad request" : "Something went wrong on the server." });
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`\nSupper Rotation is running.\n  On this computer:  http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs || []) if (a.family === "IPv4" && !a.internal) console.log(`  On your Wi-Fi:     http://${a.address}:${PORT}`);
  console.log(`  Ollama:            ${state.settings.ollamaUrl}${state.settings.model ? " (" + state.settings.model + ")" : ""}\n`);
});
