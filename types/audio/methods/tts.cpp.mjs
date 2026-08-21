export const method = {
  id: "tts.cpp",
  guide: "Use the prebuilt local tts.cpp CLI at /home/z/tts.cpp/build/bin/tts-cli. Generate exactly one WAV with --model-path, --prompt, and --save-path. Choose a compatible local GGUF model: Parler_TTS_mini_Q5.gguf or Parler_TTS_large_Q5.gguf for descriptive speech, Kokoro_espeak_Q4.gguf for multilingual/voice speech, Dia_Q4_DAC_F16.gguf for dialogue, or Orpheus.gguf for voice speech. Models are in /home/z/hf/models--mmwillet2--*/snapshots/*; resolve the actual file before running. Use --voice when the selected model supports voice packs. Inspect the WAV with ffprobe. Do not download, install, use npx, or search the network.",
  tools: ["/home/z/tts.cpp/build/bin/tts-cli", "tts.cpp", "GGUF", "ffprobe", "shell", "Node.js", "Python"]
};
