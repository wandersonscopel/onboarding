#!/usr/bin/env node

/**
 * VIRALSE ONBOARDING — CLI Interview Script
 * 
 * Conduz entrevista conversacional via terminal usando OpenRouter.
 * Salva o perfil do criador como JSON local.
 * 
 * Uso:
 *   OPENROUTER_API_KEY=sk-xxx node index.js
 *   OPENROUTER_API_KEY=sk-xxx node index.js --model google/gemini-2.5-flash-preview
 * 
 * Modelos sugeridos (OpenRouter):
 *   - google/gemini-2.5-flash                  (bom custo-benefício)
 *   - google/gemini-2.5-pro-preview              (melhor qualidade, mais caro)
 *   - anthropic/claude-sonnet-4                   (alternativa)
 *   - openai/gpt-4o                               (alternativa)
 */

require("dotenv").config();
const OpenAI = require("openai");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { SYSTEM_PROMPT } = require("./system-prompt");

// ─── Config ───────────────────────────────────────────────────────────────────

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("\n❌ Defina OPENROUTER_API_KEY no ambiente.");
  console.error("   Ex: OPENROUTER_API_KEY=sk-xxx node index.js\n");
  process.exit(1);
}

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const MODEL = getArg("--model") || DEFAULT_MODEL;
const OUTPUT_DIR = path.join(__dirname, "perfis");
const MAX_TURNS = 25; // safety limit

// ─── OpenRouter Client ────────────────────────────────────────────────────────

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: API_KEY,
});

// ─── State ────────────────────────────────────────────────────────────────────

const conversationHistory = [
  { role: "system", content: SYSTEM_PROMPT }
];

let turnCount = 0;
let profileJSON = null;
let creatorName = null;

// ─── CLI Interface ────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function main() {
  printHeader();

  // Get initial AI message (the greeting)
  const greeting = await callLLM();
  printAI(greeting);

  // Conversation loop
  while (turnCount < MAX_TURNS) {
    const userInput = await prompt("\n💬 Você: ");

    // Handle special commands
    if (userInput.trim().toLowerCase() === "/sair") {
      console.log("\n👋 Encerrando entrevista...");
      await forceFinish();
      break;
    }

    if (userInput.trim().toLowerCase() === "/status") {
      console.log(`\n📊 Turno: ${turnCount}/${MAX_TURNS} | Modelo: ${MODEL}`);
      continue;
    }

    if (userInput.trim() === "") continue;

    // Send user message and get response
    conversationHistory.push({ role: "user", content: userInput });
    
    const response = await callLLM();
    
    // Check if response contains the final JSON
    const jsonMatch = extractJSON(response);
    if (jsonMatch) {
      profileJSON = jsonMatch;
      // Print only the non-JSON part
      const cleanResponse = response.replace(/```json[\s\S]*?```/g, "").trim();
      if (cleanResponse) printAI(cleanResponse);
      
      // Save and exit
      await saveProfile();
      break;
    }

    printAI(response);
    turnCount++;

    // Safety: if approaching limit, ask AI to wrap up
    if (turnCount === MAX_TURNS - 2) {
      conversationHistory.push({
        role: "user",
        content: "[SISTEMA INTERNO - invisível ao criador] Você está chegando no limite de mensagens. Apresente o Cartão de Identidade agora e peça confirmação."
      });
      const wrapUp = await callLLM();
      printAI(wrapUp);
      turnCount++;
    }
  }

  rl.close();
  process.exit(0);
}

// ─── LLM Call ─────────────────────────────────────────────────────────────────

async function callLLM() {
  try {
    process.stdout.write("\n⏳ Pensando...");

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: conversationHistory,
      temperature: 0.7,
      max_tokens: 4096,
    });

    const content = completion.choices[0]?.message?.content || "";
    
    // Add to history
    conversationHistory.push({ role: "assistant", content });

    // Clear "thinking" indicator
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    // Log token usage if available
    const usage = completion.usage;
    if (usage) {
      const cost = estimateCost(usage, MODEL);
      logUsage(usage, cost);
    }

    return content;

  } catch (error) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    
    if (error.status === 429) {
      console.error("\n⚠️  Rate limit. Aguardando 5s...");
      await sleep(5000);
      return callLLM(); // retry
    }

    console.error(`\n❌ Erro na API: ${error.message}`);
    if (error.status === 401) {
      console.error("   Verifique sua OPENROUTER_API_KEY.");
      process.exit(1);
    }
    return "Desculpa, tive um problema técnico. Pode repetir?";
  }
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

function extractJSON(text) {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  
  try {
    const parsed = JSON.parse(match[1]);
    // Validate it's actually a profile (has our expected structure)
    if (parsed.metadata && parsed.identidade) {
      return parsed;
    }
    return null;
  } catch (e) {
    console.error("\n⚠️  JSON detectado mas inválido. Pedindo correção...");
    return null;
  }
}

// ─── Force Finish ─────────────────────────────────────────────────────────────

async function forceFinish() {
  conversationHistory.push({
    role: "user",
    content: "[SISTEMA INTERNO] O criador pediu para encerrar. Apresente o Cartão de Identidade com o que tem, peça uma confirmação rápida e gere o JSON final."
  });

  const response = await callLLM();
  const jsonMatch = extractJSON(response);
  
  if (jsonMatch) {
    profileJSON = jsonMatch;
    const cleanResponse = response.replace(/```json[\s\S]*?```/g, "").trim();
    if (cleanResponse) printAI(cleanResponse);
    await saveProfile();
  } else {
    printAI(response);
    
    // Wait for confirmation then force JSON
    const confirm = await prompt("\n💬 Você: ");
    conversationHistory.push({ role: "user", content: confirm });
    conversationHistory.push({
      role: "user",
      content: "[SISTEMA INTERNO] Gere o JSON final agora. Responda APENAS com o bloco ```json ... ```."
    });
    
    const finalResponse = await callLLM();
    const finalJson = extractJSON(finalResponse);
    
    if (finalJson) {
      profileJSON = finalJson;
      await saveProfile();
    } else {
      console.error("\n⚠️  Não foi possível extrair o JSON. Salvando conversa bruta...");
      await saveRawConversation();
    }
  }
}

// ─── Save Profile ─────────────────────────────────────────────────────────────

async function saveProfile() {
  if (!profileJSON) return;

  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Generate filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = creatorName || "criador";
  const safeName = name.toLowerCase().replace(/[^a-z0-9]/g, "_");
  const filename = `perfil_${safeName}_${timestamp}.json`;
  const filepath = path.join(OUTPUT_DIR, filename);

  // Add metadata
  profileJSON.metadata = {
    ...profileJSON.metadata,
    data_criacao: new Date().toISOString(),
    modelo_usado: MODEL,
    turnos_realizados: turnCount,
  };

  // Calculate completude
  const { filled, total } = countFields(profileJSON);
  profileJSON.metadata.completude_estimada = Math.round((filled / total) * 100) / 100;
  profileJSON.metadata.campos_preenchidos = filled;
  profileJSON.metadata.campos_total = total;

  // Save
  fs.writeFileSync(filepath, JSON.stringify(profileJSON, null, 2), "utf-8");

  console.log("\n" + "═".repeat(60));
  console.log(`✅ Perfil salvo: ${filepath}`);
  console.log(`📊 Completude: ${Math.round(profileJSON.metadata.completude_estimada * 100)}%`);
  console.log(`📊 Campos: ${filled}/${total} preenchidos`);
  console.log(`📊 Turnos: ${turnCount}`);
  console.log(`📊 Modelo: ${MODEL}`);
  console.log("═".repeat(60));

  // Also save conversation log
  const logFilename = `conversa_${safeName}_${timestamp}.json`;
  const logFilepath = path.join(OUTPUT_DIR, logFilename);
  const conversationLog = conversationHistory
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role, content: m.content }));
  fs.writeFileSync(logFilepath, JSON.stringify(conversationLog, null, 2), "utf-8");
  console.log(`💬 Conversa salva: ${logFilepath}`);
}

async function saveRawConversation() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filepath = path.join(OUTPUT_DIR, `conversa_bruta_${timestamp}.json`);
  const log = conversationHistory
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role, content: m.content }));
  fs.writeFileSync(filepath, JSON.stringify(log, null, 2), "utf-8");
  console.log(`\n💬 Conversa bruta salva: ${filepath}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countFields(obj, depth = 0) {
  let filled = 0;
  let total = 0;

  for (const [key, value] of Object.entries(obj)) {
    if (key === "metadata" || key === "diagnostico_lacunas" || key === "coerencia" || key === "flags") continue;
    
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sub = countFields(value, depth + 1);
      filled += sub.filled;
      total += sub.total;
    } else if (depth > 0) {
      total++;
      if (value !== null && value !== undefined && value !== "") {
        filled++;
      }
    }
  }

  return { filled, total };
}

function estimateCost(usage, model) {
  // Rough estimates per 1M tokens (OpenRouter pricing varies)
  const pricing = {
    "google/gemini-2.5-pro-preview": { input: 1.25, output: 10.0 },
    "google/gemini-2.5-flash": { input: 0.30, output: 2.50 },
    "google/gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
    "anthropic/claude-sonnet-4": { input: 3.0, output: 15.0 },
    "openai/gpt-4o": { input: 2.5, output: 10.0 },
  };

  const p = pricing[model] || { input: 1.0, output: 5.0 };
  const inputCost = (usage.prompt_tokens / 1_000_000) * p.input;
  const outputCost = (usage.completion_tokens / 1_000_000) * p.output;
  return inputCost + outputCost;
}

let totalCost = 0;

function logUsage(usage, cost) {
  totalCost += cost;
  // Log to file silently (don't pollute CLI)
  const logLine = `[${new Date().toISOString()}] in:${usage.prompt_tokens} out:${usage.completion_tokens} cost:$${cost.toFixed(4)} total:$${totalCost.toFixed(4)}\n`;
  fs.appendFileSync(path.join(__dirname, "usage.log"), logLine);
}

function printHeader() {
  console.clear();
  console.log("═".repeat(60));
  console.log("  🎯 VIRALSE — Onboarding do Criador");
  console.log("  📡 Modelo: " + MODEL);
  console.log("─".repeat(60));
  console.log("  Comandos:");
  console.log("    /sair    — Encerrar e salvar");
  console.log("    /status  — Ver status");
  console.log("═".repeat(60));
}

function printAI(text) {
  console.log("\n🤖 ViralSE:\n");
  // Word wrap for terminal
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.length > 80) {
      const words = line.split(" ");
      let current = "";
      for (const word of words) {
        if ((current + " " + word).length > 80) {
          console.log("  " + current.trim());
          current = word;
        } else {
          current += " " + word;
        }
      }
      if (current.trim()) console.log("  " + current.trim());
    } else {
      console.log("  " + line);
    }
  }
}

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\n❌ Erro fatal:", err.message);
  process.exit(1);
});
