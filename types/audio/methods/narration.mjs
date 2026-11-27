// Speech, offline, with nothing installed.
//
// This method exists because `tts.cpp` and `bark.cpp` need binaries that a normal machine
// does not have, and an audio card that can only make tones cannot read a card's text out
// loud - which is the thing a person asks for when they put a text card next to an audio
// card. The voice is a formant synthesizer written in this repository (`voice/`), so it
// needs no model, no download and no network. It is understandable and it is plainly
// robotic: that is said here rather than discovered on playback, and `tts.cpp`/`bark.cpp`
// stay the path to a more natural voice for anyone who has them.
//
// The guide asks for a `timeline.json` beside the WAV because that is what makes the result
// checkable. The server compares the timeline with the published file and refuses a take
// whose audio does not measure as speech, so an agent that writes a convincing JSON next to
// a file of noise cannot pass - and an agent that genuinely spoke gets that onto the card.
export const method = {
  id: "narration",
  guide: [
    "Speak text out loud with the offline voice that ships with this project. No model, binary, download or network is involved.",
    "1. Read the material. If an input card holds text, narrate that text as it is written. Otherwise narrate the user prompt itself. Never invent words that are in neither place: if there is nothing to say, return {error: \"nothing to narrate\"} with a null artifact instead of writing a script.",
    "2. Write the words you will speak to `$HYPERMAKER_NODE_DIR/script.txt`, one phrase per line, blank lines allowed. Keep sentences short - the voice has no pauses beyond line breaks and punctuation. English words and numerals only. A numeral is said the way a person reads it: `8:30` as eight thirty, `1990` as nineteen ninety, `1,200` as one thousand two hundred, `$5` as five dollars, `£0.50` as fifty pence, `$1250` as one thousand two hundred fifty dollars, `40%` as forty percent, `21st` as twenty first, `1,000,000,000,000` as one trillion, `-3.5` as minus three point five. A sign is always said: dropping it turns a loss into a gain and a frost into a heatwave. Shapes it does not read - abbreviations (`km`, `ft`), dates (`3/4/2024`), ranges (`1990-1995`), fractions, magnitudes past a trillion, and symbols it cannot name (`¥`, `₹`, `½`, `°`) - are refused (exit 2) by name and the reason says which symbol, so spell those out in words in the script rather than inventing a sound for them.",
    "3. Render, from the project root, into the directory this run was given:\n   node voice/render.mjs --file \"$HYPERMAKER_NODE_DIR/script.txt\" --out \"$HYPERMAKER_NODE_DIR/narration.wav\" --timeline \"$HYPERMAKER_NODE_DIR/timeline.json\"\n   The timeline.json is not optional: it records each phrase's text, start and duration, and the server checks the WAV against it before publishing. Render into the run directory, never into the project root.",
    "4. Check the bytes you are about to hand back, and keep the numbers:\n   node voice/render.mjs --check \"$HYPERMAKER_NODE_DIR/narration.wav\" --words \"the whole script, on one line\"\n   Exit 0 means it measured as speech and prints the verdict; exit 3 prints what it heard instead. A take that fails this check must not be returned - fix the script or the render, or return an error naming what failed.",
    "5. Return the usual JSON: {prompt, script, artifact, type: \"audio\", method: \"narration\", error}. The artifact is the WAV. Copy the check's numbers into `AGENTS.md` (duration, syllable onsets, verdict) so a person can read what was measured, and do not claim speech you did not measure.",
    "The voice is intelligible but robotic - a formant synthesizer, not a neural model. For a natural voice use tts.cpp or bark.cpp, and only when their binaries and models already exist locally."
  ].join("\n"),
  tools: ["Node.js", "voice/render.mjs", "shell"]
};
