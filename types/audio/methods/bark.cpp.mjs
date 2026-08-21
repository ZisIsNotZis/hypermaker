export const method = {
  id: "bark.cpp",
  guide: "Use the prebuilt local bark.cpp CLI at ~/bark.cpp/build/examples/main/main. Generate exactly one WAV with --model_path, --prompt, and --outwav. Use the converted local model ~/bark.cpp/models/bark-small/ggml_weights.bin; if it is missing, convert the already downloaded checkpoint with ~/bark.cpp/convert.py into that directory before generation. The source checkpoint is under ~/hf and must not be downloaded again. Inspect the WAV with ffprobe. Do not download, install, use npx, or search the network.",
  tools: ["~/bark.cpp/build/examples/main/main", "bark.cpp", "Python", "ffprobe", "shell", "Node.js"]
};
