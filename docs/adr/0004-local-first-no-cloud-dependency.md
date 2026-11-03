# Local-first with no cloud dependency

Atom-lite runs fully against local providers (Ollama, LM Studio, llama.cpp) with no cloud account, telemetry service, hosted database, or remote control plane. Hosted providers (Gemini, Kilo) are optional configuration. API keys come from environment variables or an OS secret store, never from project config or session files.

This is a hard product constraint, not a default: a repository must not be able to silently weaken it. Project config cannot override security-critical user settings.