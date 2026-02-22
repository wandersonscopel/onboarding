#!/usr/bin/env node
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const { SYSTEM_PROMPT } = require("./system-prompt");
const { REPORT_PROMPT } = require("./report-prompt");

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY && !GEMINI_KEY) { console.error("❌ Precisa de OPENROUTER_API_KEY ou GEMINI_API_KEY"); process.exit(1); }
const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) console.warn("⚠️  GROQ_API_KEY não encontrada — áudio desabilitado");
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) console.warn("⚠️  OPENAI_API_KEY não encontrada — TTS OpenAI desabilitado");
const openaiTTS = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_KEY) console.warn("⚠️  ELEVENLABS_API_KEY não encontrada — TTS ElevenLabs desabilitado");
const TTS_PROVIDER = process.env.TTS_PROVIDER || (ELEVENLABS_KEY ? 'elevenlabs' : 'openai'); // 'elevenlabs' or 'openai'
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE || 'cgSgspJ2msm6clMCkdW9'; // Jessica (pt-BR)
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5'; // Flash = 75ms latency

const SUPABASE_URL = process.env.SUPABASE_URL || "https://qguambvddobvvcwpbgng.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFndWFtYnZkZG9idnZjd3BiZ25nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0Mjk0NjUsImV4cCI6MjA4NjAwNTQ2NX0.oAnUan_S-ZmkEgN34qBSGciuR1xvVwWAvxbIYeXKC8E";

const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "gemini-2.5-flash";
const CHAT_MODEL = GEMINI_KEY ? GEMINI_MODEL : "google/" + GEMINI_MODEL; // OpenRouter needs "google/" prefix
const USE_GEMINI_DIRECT = !!GEMINI_KEY;
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Clients ──────────────────────────────────────────────────────────────────
const client = API_KEY ? new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: API_KEY }) : null;
const groqClient = GROQ_KEY ? new OpenAI({ baseURL: "https://api.groq.com/openai/v1", apiKey: GROQ_KEY }) : null;

// Google Gemini Direct Client
let geminiClient = null;
if (GEMINI_KEY) {
  try {
    const { GoogleGenAI } = require("@google/genai");
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_KEY });
    console.log("✅ Gemini Direct API initialized");
  } catch (e) {
    console.warn("⚠️  @google/genai not installed. Run: npm install @google/genai");
    console.warn("   Falling back to OpenRouter.");
  }
}

// ─── Supabase REST Helper ─────────────────────────────────────────────────────
async function supa(endpoint, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": options.prefer || "return=representation",
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── In-Memory Sessions (backed by Supabase) ─────────────────────────────────
const memSessions = new Map();

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    (file.mimetype.startsWith("audio/") || file.mimetype === "video/webm") ? cb(null, true) : cb(new Error("Tipo não suportado"));
  },
});

// ─── POST /api/auth — Login por email ─────────────────────────────────────────
app.post("/api/auth", async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email obrigatório" });

    let creators = await supa(`onboarding_creators?email=eq.${encodeURIComponent(email)}&select=*`);
    let creator = creators[0];
    if (!creator) {
      const r = await supa("onboarding_creators", { method: "POST", body: JSON.stringify({ email }) });
      creator = r[0];
    }

    const active = await supa(`onboarding_sessions?creator_id=eq.${creator.id}&status=eq.active&select=id,turn_count&order=created_at.desc&limit=1`);

    res.json({
      creator_id: creator.id, email: creator.email, name: creator.name,
      has_active_session: active.length > 0,
      session_id: active[0]?.id || null,
      turn_count: active[0]?.turn_count || 0,
    });
  } catch (err) { console.error("Auth error:", err); res.status(500).json({ error: err.message }); }
});

// ─── POST /api/start — Inicia ou recupera sessão ─────────────────────────────
app.post("/api/start", async (req, res) => {
  try {
    const { creator_id, session_id, resume } = req.body;
    if (!creator_id) return res.status(400).json({ error: "creator_id obrigatório" });

    // RESUME existing session
    if (session_id && resume) {
      const msgs = await supa(`onboarding_messages?session_id=eq.${session_id}&role=neq.system&select=role,content&order=created_at.asc`);
      const history = [{ role: "system", content: SYSTEM_PROMPT }];
      let turnCount = 0;
      for (const m of msgs) { history.push({ role: m.role, content: m.content }); if (m.role === "assistant") turnCount++; }

      memSessions.set(session_id, { history, turnCount, totalCost: 0, creatorId: creator_id });
      return res.json({
        session_id, resumed: true, turn: turnCount,
        messages: msgs.map(m => ({ role: m.role, content: m.content })),
      });
    }

    // NEW session
    const r = await supa("onboarding_sessions", { method: "POST", body: JSON.stringify({ creator_id, model: CHAT_MODEL, status: "active" }) });
    const sess = r[0];

    await supa("onboarding_messages", { method: "POST", body: JSON.stringify({ session_id: sess.id, role: "system", content: SYSTEM_PROMPT, turn_number: 0 }), prefer: "return=minimal" });

    const mem = { history: [{ role: "system", content: SYSTEM_PROMPT }], turnCount: 0, totalCost: 0, creatorId: creator_id };
    memSessions.set(sess.id, mem);

    const greeting = await callLLM(mem);
    mem.turnCount++;
    await saveMsg(sess.id, "assistant", greeting, mem.turnCount);
    await updateSess(sess.id, mem);

    res.json({ session_id: sess.id, resumed: false, greeting, turn: mem.turnCount });
  } catch (err) { console.error("Start error:", err); res.status(500).json({ error: err.message }); }
});

// ─── POST /api/chat ───────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  try {
    const { session_id, message } = req.body;
    if (!session_id || !message?.trim()) return res.status(400).json({ error: "Dados faltando" });
    const mem = memSessions.get(session_id);
    if (!mem) return res.status(404).json({ error: "Sessão não encontrada. Recarregue a página." });

    mem.history.push({ role: "user", content: message });
    await saveMsg(session_id, "user", message, mem.turnCount);

    const response = await callLLM(mem);
    mem.turnCount++;
    await saveMsg(session_id, "assistant", response, mem.turnCount);

    const { json, clean } = extractAndClean(response);
    let finished = false;
    if (json) { finished = true; await finishSess(session_id, mem, json); }
    await updateSess(session_id, mem);

    if (mem.turnCount >= 23 && !finished) {
      mem.history.push({ role: "user", content: "[SISTEMA INTERNO] Limite. Apresente Cartão de Identidade e gere JSON final." });
      const wrap = await callLLM(mem); mem.turnCount++;
      await saveMsg(session_id, "assistant", wrap, mem.turnCount);
      const w = extractAndClean(wrap);
      if (w.json) { finished = true; await finishSess(session_id, mem, w.json); }
      await updateSess(session_id, mem);
      return res.json({ response: (clean || response) + "\n\n" + (w.clean || wrap), turn: mem.turnCount, finished, session_id });
    }

    res.json({ response: clean || response, turn: mem.turnCount, finished, session_id });
  } catch (err) { console.error("Chat error:", err); res.status(500).json({ error: err.message }); }
});

// ─── POST /api/audio ──────────────────────────────────────────────────────────
app.post("/api/audio", upload.single("audio"), async (req, res) => {
  let filePath = null;
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id obrigatório" });
    if (!req.file) return res.status(400).json({ error: "Nenhum áudio" });
    if (!groqClient) return res.status(400).json({ error: "GROQ_API_KEY não configurada" });
    const mem = memSessions.get(session_id);
    if (!mem) return res.status(404).json({ error: "Sessão não encontrada" });

    filePath = req.file.path;
    const ext2 = req.file.mimetype.includes("webm") ? ".webm" : req.file.mimetype.includes("mp4") ? ".mp4" : req.file.mimetype.includes("m4a") ? ".m4a" : req.file.mimetype.includes("aac") ? ".aac" : ".webm";
    const newPath = filePath + ext2; fs.renameSync(filePath, newPath); filePath = newPath;

    const transcription = await groqClient.audio.transcriptions.create({ model: "whisper-large-v3-turbo", file: fs.createReadStream(filePath), language: "pt" });
    const text = transcription.text?.trim();
    if (!text) return res.status(400).json({ error: "Não consegui transcrever. Tente digitar." });

    mem.history.push({ role: "user", content: text });
    await saveMsg(session_id, "user", text, mem.turnCount);
    const response = await callLLM(mem); mem.turnCount++;
    await saveMsg(session_id, "assistant", response, mem.turnCount);

    const { json, clean } = extractAndClean(response);
    let finished = false;
    if (json) { finished = true; await finishSess(session_id, mem, json); }
    await updateSess(session_id, mem);

    res.json({ transcription: text, response: clean || response, turn: mem.turnCount, finished, session_id });
  } catch (err) { console.error("Audio error:", err); res.status(500).json({ error: err.message }); }
  finally { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); }
});

// ─── POST /api/finish ─────────────────────────────────────────────────────────
app.post("/api/finish", async (req, res) => {
  try {
    const { session_id } = req.body;
    const mem = memSessions.get(session_id);
    if (!mem) return res.status(404).json({ error: "Sessão não encontrada" });

    mem.history.push({ role: "user", content: "[SISTEMA INTERNO] Criador encerrou. Apresente Cartão e gere JSON final." });
    const response = await callLLM(mem); mem.turnCount++;
    await saveMsg(session_id, "assistant", response, mem.turnCount);

    let { json, clean } = extractAndClean(response);
    if (!json) {
      mem.history.push({ role: "user", content: "[SISTEMA INTERNO] Gere APENAS ```json ... ``` com o perfil." });
      const r2 = await callLLM(mem);
      const f = extractAndClean(r2);
      if (f.json) json = f.json;
    }

    let finished = false;
    if (json) { finished = true; await finishSess(session_id, mem, json); }
    await updateSess(session_id, mem);

    res.json({ response: clean || response, finished, session_id });
  } catch (err) { console.error("Finish error:", err); res.status(500).json({ error: err.message }); }
});

// ─── POST /api/reset ──────────────────────────────────────────────────────────
app.post("/api/reset", async (req, res) => {
  try {
    const { session_id } = req.body;
    if (session_id) {
      await supa(`onboarding_sessions?id=eq.${session_id}`, { method: "PATCH", body: JSON.stringify({ status: "abandoned" }), prefer: "return=minimal" });
      memSessions.delete(session_id);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/result/:id ──────────────────────────────────────────────────────
app.get("/api/result/:id", async (req, res) => {
  try {
    const data = await supa(`onboarding_sessions?id=eq.${req.params.id}&select=*,onboarding_creators(email,name)`);
    if (!data.length) return res.status(404).json({ error: "Não encontrado" });
    const s = data[0];
    res.json({ session_id: s.id, status: s.status, creator: s.onboarding_creators, profile: s.profile_json, completude: s.completude, turn_count: s.turn_count, model: s.model, created_at: s.created_at, report_md: s.report_md });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/generate-report/:id — Generate consulting report via LLM ──────
app.post("/api/generate-report/:id", async (req, res) => {
  try {
    const sid = req.params.id;
    const data = await supa("onboarding_sessions?id=eq." + sid + "&select=*,onboarding_creators(email,name)");
    if (!data.length) return res.status(404).json({ error: "Sessão não encontrada" });
    const s = data[0];
    if (!s.profile_json) return res.status(400).json({ error: "Perfil não finalizado" });

    // If already generated, return cached
    if (s.report_md && !req.body.force) {
      return res.json({ report_md: s.report_md, cached: true });
    }

    const profile = s.profile_json;
    const profileStr = JSON.stringify(profile, null, 2);

    // ── Step 1: Market Research ──
    console.log("🔍 Pesquisando mercado e concorrentes...");
    var marketData = "Dados de mercado não disponíveis — inferir a partir do perfil.";

    try {
      var nicho = profile.posicionamento?.posicionamento_nicho_core || profile.posicionamento?.posicionamento_submercado || "conteúdo digital";
      var nome = profile.branding?.branding_nome_artistico || s.onboarding_creators?.name || "";
      var refs = profile.referencias?.referencias_criadores?.join(", ") || "";
      var antiRefs = profile.referencias?.referencias_anti?.join(", ") || "";
      var plataforma = profile.formatos?.formato_plataforma_pri || "Instagram";

      var searchQueries = [
        "principais criadores de conteúdo " + nicho + " Brasil 2025 posicionamento",
        refs ? refs + " posicionamento marca pessoal estratégia conteúdo" : null,
        antiRefs ? antiRefs + " estratégia conteúdo polêmica" : null,
        "tendências " + nicho + " " + plataforma + " 2025 Brasil",
        nome ? nome + " " + plataforma : null,
      ].filter(Boolean).slice(0, 3);

      var searchResults = [];
      for (var i = 0; i < searchQueries.length; i++) {
        var query = searchQueries[i];
        try {
          var searchCompletion = await client.chat.completions.create({
            model: "google/gemini-2.5-flash",
            messages: [{ role: "user", content: "Pesquise e resuma em 200 palavras: " + query + ". Foque em: posicionamento, estética, palavra-território, fase no mercado, formatos usados, tamanho de audiência." }],
            temperature: 0.3,
            max_tokens: 500,
          });
          var result = searchCompletion.choices[0]?.message?.content;
          if (result) searchResults.push("**Pesquisa: \"" + query + "\"**\n" + result);
        } catch (e) {
          console.log("  ⚠️ Search failed for: " + query);
        }
      }

      if (searchResults.length > 0) {
        marketData = searchResults.join("\n\n---\n\n");
        console.log("  ✅ " + searchResults.length + " pesquisas realizadas");
      }
    } catch (e) {
      console.log("  ⚠️ Market research failed, proceeding with inference");
    }

    // ── Step 2: Generate Report ──
    console.log("📝 Gerando relatório de diagnóstico completo...");

    var prompt = REPORT_PROMPT
      .replace("{{PROFILE_JSON}}", profileStr)
      .replace("{{MARKET_DATA}}", marketData);

    var reportModel = req.body.model || "google/gemini-2.5-flash";
    var completion = await client.chat.completions.create({
      model: reportModel,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Gere o relatório de diagnóstico e construção completo para este criador. Siga TODAS as seções da estrutura obrigatória. Inclua a construção do editorial e do Primal Branding." }
      ],
      temperature: 0.6,
      max_tokens: 16384,
    });

    var reportMd = completion.choices[0]?.message?.content || "";

    // Save to Supabase
    await supa("onboarding_sessions?id=eq." + sid, {
      method: "PATCH",
      body: JSON.stringify({ report_md: reportMd, updated_at: new Date().toISOString() }),
      prefer: "return=minimal",
    });

    var cost = 0;
    if (completion.usage) {
      var prices = { "google/gemini-2.5-flash": [0.30, 2.50], "google/gemini-2.5-pro-preview": [1.25, 10] };
      var p = prices[reportModel] || [1, 5];
      cost = (completion.usage.prompt_tokens / 1e6 * p[0]) + (completion.usage.completion_tokens / 1e6 * p[1]);
    }

    console.log("✅ Relatório gerado (" + reportMd.length + " chars, $" + cost.toFixed(4) + ")");
    res.json({ report_md: reportMd, cached: false, cost: "$" + cost.toFixed(4) });

  } catch (err) {
    console.error("Report error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /resultado/:id — HTML page ───────────────────────────────────────────
app.get("/resultado/:id", (req, res) => { res.sendFile(path.join(__dirname, "public", "resultado.html")); });

// ─── LLM ──────────────────────────────────────────────────────────────────────
// Convert OpenAI-style messages to Gemini format
function toGeminiContents(messages) {
  const systemParts = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  // Gemini requires at least one content entry — if empty (greeting), add a trigger
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Comece a entrevista.' }] });
  }
  return { systemInstruction: systemParts || undefined, contents };
}

async function callLLM(mem) {
  if (geminiClient) {
    // Gemini Direct
    const { systemInstruction, contents } = toGeminiContents(mem.history);
    const response = await geminiClient.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction, temperature: 0.7, maxOutputTokens: 4096 }
    });
    const content = response.text || "";
    mem.history.push({ role: "assistant", content });
    return content;
  } else {
    // OpenRouter fallback
    const c = await client.chat.completions.create({ model: CHAT_MODEL, messages: mem.history, temperature: 0.7, max_tokens: 4096 });
    const content = c.choices[0]?.message?.content || "";
    mem.history.push({ role: "assistant", content });
    if (c.usage) {
      const p = { "google/gemini-2.5-flash": [0.30, 2.50], "google/gemini-2.5-pro-preview": [1.25, 10] }[CHAT_MODEL] || [1, 5];
      mem.totalCost += (c.usage.prompt_tokens / 1e6 * p[0]) + (c.usage.completion_tokens / 1e6 * p[1]);
    }
    return content;
  }
}

// Streaming LLM call — yields deltas
async function* streamLLM(messages) {
  if (geminiClient) {
    const { systemInstruction, contents } = toGeminiContents(messages);
    const response = await geminiClient.models.generateContentStream({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction, temperature: 0.7, maxOutputTokens: 4096 }
    });
    for await (const chunk of response) {
      const text = chunk.text || "";
      if (text) yield text;
    }
  } else {
    const stream = await client.chat.completions.create({
      model: CHAT_MODEL, messages, temperature: 0.7, max_tokens: 4096, stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) yield delta;
    }
  }
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────
async function saveMsg(sid, role, content, turn) {
  try { await supa("onboarding_messages", { method: "POST", body: JSON.stringify({ session_id: sid, role, content: fixEnc(content), turn_number: turn }), prefer: "return=minimal" }); }
  catch (e) { console.error("saveMsg:", e.message); }
}

async function updateSess(sid, mem) {
  try { await supa(`onboarding_sessions?id=eq.${sid}`, { method: "PATCH", body: JSON.stringify({ turn_count: mem.turnCount, total_cost: mem.totalCost, updated_at: new Date().toISOString() }), prefer: "return=minimal" }); }
  catch (e) { console.error("updateSess:", e.message); }
}

async function finishSess(sid, mem, json) {
  try {
    const fixed = JSON.parse(fixEnc(JSON.stringify(json)));
    const { filled, total } = countFields(fixed);
    const comp = Math.round((filled / total) * 100) / 100;
    fixed.metadata = { ...fixed.metadata, data_criacao: new Date().toISOString(), modelo_usado: CHAT_MODEL, turnos_realizados: mem.turnCount, custo_total: `$${mem.totalCost.toFixed(4)}`, completude_estimada: comp, campos_preenchidos: filled, campos_total: total };
    await supa(`onboarding_sessions?id=eq.${sid}`, { method: "PATCH", body: JSON.stringify({ status: "completed", profile_json: fixed, completude: comp, turn_count: mem.turnCount, total_cost: mem.totalCost, updated_at: new Date().toISOString() }), prefer: "return=minimal" });
    console.log(`✅ Perfil salvo: ${sid} | ${Math.round(comp * 100)}% (${filled}/${total})`);
  } catch (e) { console.error("finishSess:", e.message); }
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function extractAndClean(text) {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!m) return { json: null, clean: null };
  try {
    const parsed = JSON.parse(fixEnc(m[1]));
    if (parsed.metadata && parsed.identidade) return { json: parsed, clean: text.replace(/```json[\s\S]*?```/g, "").trim() || null };
  } catch (e) { console.error("JSON parse:", e.message); }
  return { json: null, clean: null };
}

function fixEnc(str) {
  try { if (!/Ã©|Ã£|Ã§|Ã³|Ãº|Ã¡|Ãª|Ã­|Ã´|Ã¢/.test(str)) return str; const d = Buffer.from(str, 'latin1').toString('utf-8'); if (!d.includes('�')) return d; } catch (e) {}
  return str;
}

function countFields(obj, d = 0) {
  let f = 0, t = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (["metadata", "diagnostico_lacunas", "coerencia", "flags"].includes(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) { const s = countFields(v, d + 1); f += s.f; t += s.t; }
    else if (d > 0) { t++; if (v !== null && v !== undefined && v !== "") f++; }
  }
  return { filled: f, total: t };
}

// ─── POST /api/tts — Text-to-Speech (ElevenLabs ou OpenAI) ──────────────────
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "Texto obrigatório" });

    if (TTS_PROVIDER === 'elevenlabs' && ELEVENLABS_KEY) {
      const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.substring(0, 4000),
          model_id: ELEVENLABS_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
          output_format: 'mp3_22050_32',
        })
      });
      if (!elRes.ok) throw new Error(`ElevenLabs ${elRes.status}`);
      const buffer = Buffer.from(await elRes.arrayBuffer());
      res.set({ "Content-Type": "audio/mpeg", "Content-Length": buffer.length });
      res.send(buffer);
    } else if (openaiTTS) {
      const mp3 = await openaiTTS.audio.speech.create({
        model: "gpt-4o-mini-tts", voice: voice || "coral",
        input: text.substring(0, 4000), response_format: "mp3", speed: 1.05,
        instructions: "Fale em português brasileiro com tom natural e conversacional. Tom direto, profissional mas amigável."
      });
      const buffer = Buffer.from(await mp3.arrayBuffer());
      res.set({ "Content-Type": "audio/mpeg", "Content-Length": buffer.length });
      res.send(buffer);
    } else {
      res.status(400).json({ error: "Nenhum TTS configurado" });
    }
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/voice — Combined Audio flow: STT → LLM → TTS ─────────────────
app.post("/api/voice", upload.single("audio"), async (req, res) => {
  let filePath = null;
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "session_id obrigatório" });
    if (!req.file) return res.status(400).json({ error: "Nenhum áudio" });
    if (!groqClient) return res.status(400).json({ error: "GROQ_API_KEY não configurada" });
    const mem = memSessions.get(session_id);
    if (!mem) return res.status(404).json({ error: "Sessão não encontrada" });

    filePath = req.file.path;
    const mime = req.file.mimetype || "";
    const ext = mime.includes("webm") ? ".webm" : mime.includes("mp4") ? ".mp4" : mime.includes("m4a") ? ".m4a" : mime.includes("ogg") ? ".ogg" : mime.includes("aac") ? ".aac" : mime.includes("wav") ? ".wav" : ".webm";
    const newPath = filePath + ext; fs.renameSync(filePath, newPath); filePath = newPath;

    // STT
    const transcription = await groqClient.audio.transcriptions.create({ model: "whisper-large-v3-turbo", file: fs.createReadStream(filePath), language: "pt" });
    const text = transcription.text?.trim();
    if (!text) return res.status(400).json({ error: "Não consegui transcrever." });

    // LLM
    mem.history.push({ role: "user", content: text });
    await saveMsg(session_id, "user", text, mem.turnCount);
    const response = await callLLM(mem); mem.turnCount++;
    await saveMsg(session_id, "assistant", response, mem.turnCount);

    const { json, clean } = extractAndClean(response);
    let finished = false;
    if (json) { finished = true; await finishSess(session_id, mem, json); }
    await updateSess(session_id, mem);

    const textResponse = clean || response;

    // TTS (if available)
    let audioBase64 = null;
    if (openaiTTS && !finished) {
      try {
        const ttsVoice = req.body.voice || "coral";
        const mp3 = await openaiTTS.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice: ttsVoice,
          input: textResponse.substring(0, 4000),
          response_format: "mp3",
          speed: 1.05,
          instructions: "Fale em português brasileiro com tom natural e conversacional. Você é um consultor estratégico entrevistando um criador de conteúdo. Tom direto, profissional mas amigável. Sem exageros, sem tom de robô."
        });
        const buf = Buffer.from(await mp3.arrayBuffer());
        audioBase64 = buf.toString("base64");
      } catch (e) { console.error("TTS in voice flow:", e.message); }
    }

    res.json({ transcription: text, response: textResponse, turn: mem.turnCount, finished, session_id, audio: audioBase64 });
  } catch (err) { console.error("Voice error:", err); res.status(500).json({ error: err.message }); }
  finally { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); }
});

// ─── GET /api/bench — Benchmark latency of each step ─────────────────────────
app.get("/api/bench", async (req, res) => {
  const results = {};
  const testText = "Olá, tudo bem? Me conta um pouco sobre o que você faz.";
  
  // Test STT (skip, needs audio file)
  results.stt = "Precisa de áudio — teste via /bench page";

  // Test LLM
  try {
    const t0 = Date.now();
    if (geminiClient) {
      const r = await geminiClient.models.generateContent({
        model: GEMINI_MODEL,
        contents: "Olá",
        config: { systemInstruction: "Responda em 1 frase curta em português.", temperature: 0.7, maxOutputTokens: 100 }
      });
      results.llm = { ms: Date.now() - t0, model: GEMINI_MODEL + " (direto)", response: (r.text || "").substring(0, 80) };
    } else {
      const c = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: "system", content: "Responda em 1 frase curta em português." }, { role: "user", content: "Olá" }],
        temperature: 0.7, max_tokens: 100
      });
      results.llm = { ms: Date.now() - t0, model: CHAT_MODEL + " (OpenRouter)", response: c.choices[0]?.message?.content?.substring(0, 80) };
    }
  } catch (e) { results.llm = { error: e.message }; }

  // Test TTS
  if (openaiTTS) {
    try {
      const t0 = Date.now();
      const mp3 = await openaiTTS.audio.speech.create({
        model: "gpt-4o-mini-tts", voice: "coral",
        input: testText, response_format: "mp3", speed: 1.05,
        instructions: "Fale em português brasileiro."
      });
      const buf = Buffer.from(await mp3.arrayBuffer());
      results.tts = { ms: Date.now() - t0, bytes: buf.length, chars: testText.length };
    } catch (e) { results.tts = { error: e.message }; }
  } else { results.tts = { error: "OPENAI_API_KEY não configurada" }; }

  res.json(results);
});

// ─── POST /api/voice-stream — SSE: STT → LLM stream + TTS por sentença ──────
const TTS_INSTRUCTIONS = "Fale em português brasileiro com tom natural e conversacional. Tom direto, profissional mas amigável. Sem exageros.";

app.post("/api/voice-stream", upload.single("audio"), async (req, res) => {
  let filePath = null;
  
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch(e) {}
  };
  
  try {
    const { session_id } = req.body;
    if (!session_id) { send("error", { error: "session_id obrigatório" }); res.end(); return; }
    if (!req.file) { send("error", { error: "Nenhum áudio" }); res.end(); return; }
    if (!groqClient) { send("error", { error: "GROQ_API_KEY não configurada" }); res.end(); return; }
    const mem = memSessions.get(session_id);
    if (!mem) { send("error", { error: "Sessão não encontrada" }); res.end(); return; }

    filePath = req.file.path;
    const mime = req.file.mimetype || "";
    const ext = mime.includes("webm") ? ".webm" : mime.includes("mp4") ? ".mp4" : mime.includes("m4a") ? ".m4a" : mime.includes("ogg") ? ".ogg" : mime.includes("aac") ? ".aac" : mime.includes("wav") ? ".wav" : ".webm";
    const newPath = filePath + ext; fs.renameSync(filePath, newPath); filePath = newPath;

    // ── Step 1: STT ──
    const t0 = Date.now();
    const transcription = await groqClient.audio.transcriptions.create({ 
      model: "whisper-large-v3-turbo", file: fs.createReadStream(filePath), language: "pt" 
    });
    const userText = transcription.text?.trim();
    if (!userText) { send("error", { error: "Não consegui transcrever." }); res.end(); return; }
    
    send("transcription", { text: userText, stt_ms: Date.now() - t0 });

    mem.history.push({ role: "user", content: userText });
    saveMsg(session_id, "user", userText, mem.turnCount); // fire and forget

    // ── Step 2: LLM stream + TTS por sentença ──
    const t1 = Date.now();
    let fullResponse = "";
    let firstTokenMs = 0;
    let sentenceBuffer = "";
    let sentenceIndex = 0;
    const ttsPromises = [];
    let deltaCount = 0;
    
    // Greedy sentence extractor: finds all complete sentences in accumulated buffer
    const extractSentences = (buf) => {
      const sentences = [];
      let remaining = buf;
      // Keep extracting sentences while we can find punct + space patterns
      while (true) {
        // Match: at least 15 chars, ending with . ! ? : ; followed by whitespace
        const m = remaining.match(/^(.{15,}?[.!?:;])\s+([\s\S]*)$/);
        if (m) {
          sentences.push(m[1].trim());
          remaining = m[2];
        } else {
          break;
        }
      }
      return { sentences, remaining };
    };

    const fireTTS = (text, idx) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const t = Date.now();
      console.log(`  🔊 TTS #${idx} [${TTS_PROVIDER}]: "${trimmed.substring(0,60)}" (${trimmed.length}ch)`);

      let promise;

      if (TTS_PROVIDER === 'elevenlabs' && ELEVENLABS_KEY) {
        // ElevenLabs with-timestamps — returns audio + character-level alignment
        promise = fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/with-timestamps`, {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: trimmed.substring(0, 4000),
            model_id: ELEVENLABS_MODEL,
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
            output_format: 'mp3_22050_32',
          })
        }).then(async (res) => {
          if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
          const data = await res.json();
          // data.audio_base64, data.alignment { characters, character_start_times_seconds, character_end_times_seconds }
          const alignment = data.alignment;
          let wordTimings = [];
          if (alignment && alignment.characters) {
            // Convert character-level to word-level timings
            let wordStart = -1, currentWord = '';
            for (let i = 0; i < alignment.characters.length; i++) {
              const ch = alignment.characters[i];
              if (ch === ' ' || ch === '\n') {
                if (currentWord) {
                  wordTimings.push({ word: currentWord, start: wordStart, end: alignment.character_end_times_seconds[i - 1] });
                  currentWord = '';
                  wordStart = -1;
                }
              } else {
                if (wordStart === -1) wordStart = alignment.character_start_times_seconds[i];
                currentWord += ch;
              }
            }
            if (currentWord) {
              wordTimings.push({ word: currentWord, start: wordStart, end: alignment.character_end_times_seconds[alignment.characters.length - 1] });
            }
          }
          send("tts_chunk", { 
            audio: data.audio_base64, 
            index: idx, 
            text: trimmed, 
            tts_ms: Date.now() - t,
            word_timings: wordTimings 
          });
          console.log(`  ✅ TTS #${idx}: ${Date.now() - t}ms (${wordTimings.length} words aligned)`);
        }).catch(e => {
          console.error(`  ❌ TTS #${idx}:`, e.message);
          send("tts_error", { error: e.message, index: idx });
        });
      } else if (openaiTTS) {
        // OpenAI TTS (no alignment)
        promise = openaiTTS.audio.speech.create({
          model: "gpt-4o-mini-tts", voice: "coral",
          input: trimmed.substring(0, 4000),
          response_format: "mp3", speed: 1.05,
          instructions: TTS_INSTRUCTIONS,
        }).then(async (mp3) => {
          const buf = Buffer.from(await mp3.arrayBuffer());
          send("tts_chunk", { audio: buf.toString("base64"), index: idx, text: trimmed, tts_ms: Date.now() - t });
          console.log(`  ✅ TTS #${idx}: ${Date.now() - t}ms`);
        }).catch(e => {
          send("tts_error", { error: e.message, index: idx });
        });
      } else {
        return;
      }

      ttsPromises.push(promise);
    };

    const llmStream = streamLLM(mem.history);

    for await (const delta of llmStream) {
      deltaCount++;
      if (!firstTokenMs) firstTokenMs = Date.now() - t1;
      fullResponse += delta;
      sentenceBuffer += delta;
      send("llm_delta", { delta });

      if (deltaCount <= 10) console.log(`  📝 d[${deltaCount}] ${delta.length}ch: "${delta.replace(/\n/g,'\\n').substring(0,80)}"`);

      const { sentences, remaining } = extractSentences(sentenceBuffer);
      for (const s of sentences) {
        fireTTS(s, sentenceIndex);
        sentenceIndex++;
      }
      sentenceBuffer = remaining;
    }
    console.log(`  📊 ${deltaCount} deltas, ${sentenceIndex} TTS chunks, buf: "${sentenceBuffer.substring(0,50)}"`);
    
    // Fire TTS for remaining text
    if (sentenceBuffer.trim()) {
      fireTTS(sentenceBuffer, sentenceIndex);
      sentenceIndex++;
    }
    
    const llmMs = Date.now() - t1;
    mem.history.push({ role: "assistant", content: fullResponse });
    mem.turnCount++;
    saveMsg(session_id, "assistant", fullResponse, mem.turnCount); // fire and forget

    const { json, clean } = extractAndClean(fullResponse);
    let finished = false;
    if (json) { finished = true; await finishSess(session_id, mem, json); }
    updateSess(session_id, mem); // fire and forget

    const textResponse = clean || fullResponse;
    send("llm_done", { text: textResponse, llm_ms: llmMs, first_token_ms: firstTokenMs, turn: mem.turnCount, finished, total_chunks: sentenceIndex });

    if (finished) { send("done", { finished: true }); res.end(); return; }

    // Wait for all TTS chunks to complete
    await Promise.allSettled(ttsPromises);

    send("done", { finished: false, total_chunks: sentenceIndex });
    res.end();

  } catch (err) {
    console.error("Voice-stream error:", err);
    try { send("error", { error: err.message }); } catch(e) {}
    res.end();
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

// ─── GET /bench — Benchmark page ─────────────────────────────────────────────
app.get("/bench", (req, res) => { res.sendFile(path.join(__dirname, "public", "bench.html")); });

// ─── GET /voice — Voice interface ────────────────────────────────────────────
app.get("/voice", (req, res) => { res.sendFile(path.join(__dirname, "public", "voice.html")); });

// ─── GET /live — Live Voice interface (Gemini Live API) ─────────────────────
app.get("/live", (req, res) => { res.sendFile(path.join(__dirname, "public", "live-voice.html")); });

// ─── POST /api/live-token — Generate ephemeral token for Gemini Live ────────
app.post("/api/live-token", express.json(), async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY não configurada" });
  
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email obrigatório" });

    // Build a condensed system instruction for Live (keep it shorter for real-time)
    const systemInstruction = `Você é o entrevistador do Fleway — plataforma de análise de conteúdo viral.

PAPEL: Estrategista de posicionamento conduzindo uma entrevista conversacional com um criador de conteúdo.

TOM: Informal, direto, profissional. Fale como consultor brasileiro experiente. Tuteia. Sem coach motivacional.

IDIOMA: Português brasileiro. Fale de forma natural e concisa — respostas curtas (2-3 frases por turno).

OBJETIVO: Entrevistar o criador por ~15 min pra montar o perfil estratégico dele. Cubra:
1. Quem é, o que faz, como chegou aqui
2. Nicho, público-alvo, proposta de valor
3. Plataformas, formatos, frequência de publicação
4. O que funciona/não funciona no conteúdo atual
5. Objetivos de crescimento, monetização
6. Dificuldades, gargalos, frustrações

REGRAS:
- Uma pergunta por vez. Espere a resposta antes de avançar.
- Reaja ao que o criador disse antes de perguntar algo novo.
- Se a resposta for vaga, faça follow-up antes de mudar de tema.
- Mantenha a conversa fluida — não interrogue.
- Quando cobrir tudo (~8-10 trocas), sinalize que está finalizando.

Comece se apresentando brevemente e perguntando quem é o criador.`;

    // Try to generate ephemeral token via Gemini API
    // If @google/genai supports authTokens, use it; otherwise return the raw API key
    // (for development/prototype — in production, always use ephemeral tokens)
    // For Live API WebSocket, use API key directly
    // Ephemeral tokens have compatibility issues with browser WebSocket connections
    // In production, use a server-side WebSocket proxy instead
    const token = GEMINI_KEY;

    res.json({ token, systemInstruction, model: GEMINI_MODEL, isEphemeral: false });
  } catch (e) {
    console.error("Live token error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  🎯 Fleway Onboarding v7 (Voice Edition)`);
  console.log(`  📡 ${USE_GEMINI_DIRECT ? GEMINI_MODEL + " (direto)" : CHAT_MODEL + " (OpenRouter)"}`);
  console.log(`  🎤 ${groqClient ? "Groq STT ✅" : "❌"} | 🔊 ${openaiTTS ? "OpenAI TTS ✅" : "❌"} | 💾 Supabase ✅`);
  console.log(`  🌐 http://localhost:${PORT} (chat)`);
  console.log(`  🎙️  http://localhost:${PORT}/voice (push-to-talk)`);
  console.log(`  📞 http://localhost:${PORT}/live (conversa fluida)`);
  console.log(`  📊 http://localhost:${PORT}/bench (benchmark)`);
  console.log(`${"═".repeat(50)}\n`);
});
