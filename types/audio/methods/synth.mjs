export const method = {
  id: "synth",
  // This method exists because the two speech methods need binaries that a machine
  // may not have, while "audio" as a card type should still be able to produce a
  // file that really plays. Be explicit about what it cannot do, so nobody reads a
  // generated soundtrack as generated speech.
  guide: "Use Node.js only, offline. Write one script that synthesizes PCM samples and then writes a valid RIFF/WAVE file itself: 16-bit little-endian mono PCM, 44100 Hz, 44-byte header plus a `data` chunk whose size matches the samples. Fill the samples with math (sines, harmonics, envelopes, noise, simple filters) and keep peak amplitude below 0.9 to avoid clipping. Do not use ffmpeg, sox, npx, package installs, or the network; there is no speech model here, so this produces tones, chords, rhythm, ambience and sound effects, not spoken words. For speech, use the tts.cpp method and only when its binary and a GGUF model already exist locally. After writing the file, read back the first 4 bytes and check they are RIFF, and that the byte length equals 44 plus the sample data size.",
  tools: ["Node.js", "shell"]
};
