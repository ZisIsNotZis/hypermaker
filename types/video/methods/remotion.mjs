// Video has its own guide rather than re-exporting the image one, because a video
// card is the only card that can be handed audio as an input, and a real run
// showed what that costs when the guide stays quiet about it: the agent produced
// an MP4 whose container had a valid AAC track of pure digital silence (peak 0 on
// every sample). Every cheap check passed - the file was an MP4, it had an audio
// stream, the canvas played it - and the result was a silent film.
export const method = {
  id: "remotion",
  guide: [
    "Use Remotion 4, @remotion/bundler, @remotion/renderer, React, local Rspack, Playwright Chromium, and FFmpeg.",
    "Write one self-contained .mjs/.js script with registerRoot() and Composition; bundle with {rspack: true}; render with renderMedia(). Inspect once, repair only if invalid.",
    "Remotion needs a browser executable: pass process.env.HYPERMAKER_CHROME (or CHROME_BIN) as browserExecutable and chromiumOptions.executablePath when it is set. Do not install a browser, search packages, run npx, or use the network.",
    "MIXING AUDIO INPUTS: when an input is an audio file, the film must actually contain that sound, not merely an audio track. Copy the input file into a `public/` directory you create, pass that directory to bundle() as `publicDir`, and reference the file with <Audio src={staticFile('<name>')} /> from inside the composition. Use the total duration the audio needs: set durationInFrames so the picture lasts at least as long as the music. The composition must also render visible picture for the whole duration, or the audio has nothing to attach to.",
    "VERIFY THE SOUND, NOT THE CONTAINER: after rendering, extract the embedded track and measure it, for example\n  ffmpeg -y -i out.mp4 -map 0:a:0 -ac 1 -ar 44100 check.wav\n  then read check.wav's samples and confirm that many are not zero. A track that exists but is all zeros is a failure, and so is a container with no audio stream at all. Report what you measured in your final message. Do not claim audio you have not measured.",
    "If no audio input was given, a silent render is correct and no audio track is expected."
  ].join("\n"),
  tools: ["Remotion 4", "@remotion/bundler", "@remotion/renderer", "React", "Rspack", "Playwright Chromium", "FFmpeg", "Node.js"]
};
