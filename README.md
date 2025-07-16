# Swift

Swift es un asistente de voz rápido y open-source.

- [Dify](https://dify.ai) se usa para la generación de texto (LLM).
- [Fish Audio](https://fish.audio) se usa para la síntesis de voz (TTS) en streaming.
- [OpenAI Whisper](https://platform.openai.com/docs/guides/speech-to-text) se usa para la transcripción de audio a texto.
- [VAD](https://www.vad.ricky0123.com/) se usa para detectar cuándo el usuario está hablando.
- El frontend es Next.js + React.

## Variables de entorno

- `DIFY_API_KEY`: clave para Dify
- `FISH_AUDIO_API_KEY`, `FISH_AUDIO_MODEL`, `FISH_AUDIO_ID_REFERENCIA`: claves para Fish Audio
- `WHISPER_API_KEY`: clave para OpenAI Whisper

## Desarrollo

- Clona el repositorio
- Copia `.env.example` a `.env.local` y completa las variables
- Ejecuta `pnpm install`
- Ejecuta `pnpm dev` para desarrollo

---

¡Gracias a Dify, Fish Audio y OpenAI por sus APIs!
