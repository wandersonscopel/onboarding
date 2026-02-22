# VIRALSE Onboarding v7 — Voice Edition

Entrevista conversacional com IA para criar o perfil estratégico do criador de conteúdo. **Agora com modo 100% voz.**

## Setup

```bash
npm install
cp .env.example .env
```

### Variáveis de ambiente (.env)

```env
OPENROUTER_API_KEY=sk-or-...     # LLM (Gemini Flash via OpenRouter)
GROQ_API_KEY=gsk_...             # STT (Whisper) — obrigatório pra voz
OPENAI_API_KEY=sk-...            # TTS (gpt-4o-mini-tts) — obrigatório pra voz
```

## Uso

```bash
# Iniciar servidor
node server.js

# Interfaces disponíveis:
# 🌐 http://localhost:3000       — Chat (texto + áudio)
# 🎙️  http://localhost:3000/voice — Voice (entrevista por voz)

# Outro modelo
node server.js --model google/gemini-2.5-pro-preview
```

## Modo Voice — Como funciona

1. O criador abre `/voice` e faz login por email
2. A IA inicia a entrevista falando (TTS)
3. O criador toca o botão central para falar (push-to-talk)
4. O áudio é transcrito (Groq Whisper) → processado pelo LLM → resposta é lida em voz alta (OpenAI TTS)
5. Ciclo se repete naturalmente, como uma conversa real
6. Ao final, o perfil é salvo como JSON

### Controles no modo Voice

| Controle | Ação |
|----------|------|
| Toque no orb | Começar/parar de gravar |
| Toque durante fala | Interromper a IA |
| Botão "Teclado" | Alternar para digitação |
| Botão "Áudio on/off" | Ligar/desligar TTS |
| Botão "Encerrar" | Finalizar e salvar perfil |

## Stack de Voz

| Componente | Provedor | Custo |
|-----------|----------|-------|
| STT | Groq Whisper Large v3 Turbo | ~$0.00 (free tier) |
| LLM | Gemini 2.5 Flash (OpenRouter) | ~$0.02-0.05/entrevista |
| TTS | OpenAI gpt-4o-mini-tts | ~$0.02-0.05/entrevista |
| **Total** | | **~$0.04-0.10/entrevista** |

## Estrutura

```
viralse-onboarding-v7/
├── server.js          # Backend (Express + STT + LLM + TTS)
├── index.js           # CLI alternativo
├── system-prompt.js   # System prompt da entrevista
├── report-prompt.js   # Prompt do relatório
├── public/
│   ├── index.html     # Frontend chat (texto + áudio)
│   ├── voice.html     # Frontend voice-first (NOVO)
│   └── resultado.html # Página de resultado
├── .env
├── package.json
└── README.md
```

## Voz TTS

O TTS usa `gpt-4o-mini-tts` da OpenAI com a voice `coral` (feminina, natural em PT-BR).
Vozes disponíveis: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer.

Para trocar a voz, edite o parâmetro `voice` nos endpoints `/api/tts` e `/api/voice` no `server.js`.
