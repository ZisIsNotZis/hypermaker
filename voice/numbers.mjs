// How a written number becomes words a listener can follow.
//
// The defect this exists for, measured on the shipped build:
//
//   "The train leaves at 8:30."        refused outright - `8:30` is not letters or digits
//   "The house was built in 1990."     said "one nine nine zero", not "nineteen ninety"
//   "We sold 1,200 copies."            refused
//   "It costs $5."                     said "five" - the unit vanished
//   "Prices rose 40% last year."       said "four zero"
//   "The 21st century began in 2001."  refused
//
// Those are ordinary narration lines. A creator who writes one does not get a robotic take of
// their sentence, they get a refusal, or a take that says a different sentence. Both are worse
// than a bad voice: the card either cannot be made or lies about what it says.
//
// So this file is a *reading* of a numeral, not a number engine for arithmetic. It answers one
// question - "what would a person say out loud when they read this token?" - for the shapes
// that appear in prose, and it returns `null` for anything else, which leaves the token to be
// refused as before rather than guessed at.
//
// The judgements that had to be made, and why:
//
//   * thousands use no "and" (`one thousand two hundred`). Both forms exist in English; this
//     is the one most narration reads aloud.
//   * a four-digit number is read as a year (`1990` -> nineteen ninety) only when it is written
//     without a thousands separator, falls in 1100..2999, and is not a round hundred or
//     thousand. `1,200` is a count, and the comma is the writer's own mark that it is one; so
//     is a bare `1200`. `2000`..`2009` are read `two thousand (one)`, which is how people say
//     them; `1905` is `nineteen oh five`.
//   * a colon between two numbers is a clock time (`8:30` -> eight thirty, `8:05` -> eight oh
//     five). A creator writing a score or a ratio would be read as a time, and that is the only
//     reading this shape has in prose; refusing an ordinary time is the worse failure.
//   * the unit a symbol carries is said, not dropped: `$5` is `five dollars`, `40%` is `forty
//     percent`. A listener hearing only "five" has lost the word that carried the meaning.
//   * a decimal point is said, and its fraction digit by digit.
//
// What is deliberately *not* handled: abbreviations (`km`, `ft`), ranges (`1990-1995`), dates
// (`3/4/2024`) and a misplaced ordinal suffix (`2st`). They keep failing loudly, with the same
// refusal as before, because a wrong guess about a date is a sentence that is confidently about
// a different day.
//
// None of this changes what an existing recording sounds like. Numbers are read here only by
// the reading set added for them (`cmudict-3`); the frozen sets keep their digit-by-digit
// reading to the sample, which is what lets a take made before this file still verify.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion"];

const under100 = n => n < 20 ? [ONES[n]] : n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[Math.floor(n / 10)]];

// 0 .. 999,999,999,999, without "and".
export function cardinal(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return ["zero"];
  const groups = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  const words = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (!group) continue;
    if (group >= 100) {
      words.push(ONES[Math.floor(group / 100)], "hundred");
      if (group % 100) words.push(...under100(group % 100));
    } else words.push(...under100(group));
    if (SCALES[i]) words.push(SCALES[i]);
  }
  return words;
}

// `1990` -> nineteen ninety, `1905` -> nineteen oh five, `2000` -> two thousand,
// `2007` -> two thousand seven, `1100` -> eleven hundred.
export function asYear(n) {
  n = Math.floor(Number(n));
  if (n >= 2000 && n < 2010) return n === 2000 ? ["two", "thousand"] : ["two", "thousand", ONES[n - 2000]];
  const high = Math.floor(n / 100), low = n % 100;
  if (low === 0) return [...under100(high), "hundred"];
  if (low < 10) return [...under100(high), "oh", ONES[low]];
  return [...under100(high), ...under100(low)];
}

const ORDINAL_IRREGULAR = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
export function ordinal(n) {
  const words = cardinal(n);
  if (!words) return null;
  const last = words.pop();
  if (ORDINAL_IRREGULAR[last]) return [...words, ORDINAL_IRREGULAR[last]];
  if (last.endsWith("y")) return [...words, `${last.slice(0, -1)}ieth`];
  return [...words, `${last}th`];
}

// Only used for a decade (`nineties`), where the last written word carries the plural.
const plural = word => word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`;

const suffixAgrees = (n, suffix) => {
  const want = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return suffix === want;
};

const MONEY = { $: ["dollar", "dollars"], "£": ["pound", "pounds"], "€": ["euro", "euros"] };

// One written number, with the decisions above applied. `value` and `decimal` come back too,
// because a unit's singular or plural depends on them ("one dollar", "two dollars").
function stripNumber(text) {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? null : body.slice(dot + 1);
  const commas = whole.includes(",");
  const digits = whole.replace(/,/g, "");
  if (!/^\d+$/.test(digits) || (commas && !/^\d{1,3}(,\d{3})+$/.test(whole))) return null;
  if (fraction != null && !/^\d+$/.test(fraction)) return null;
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) return null;
  const words = [];
  if (negative) words.push("minus");
  if (fraction == null) {
    // A year only when written without a separator, in the range people write years in - and
    // only when it is not a round hundred or a round thousand. `1200` in prose is a count and
    // is said `one thousand two hundred`; `1200 BC` would want `twelve hundred`, but the year
    // reading of a bare four-digit number is the more common one only inside a real year range.
    const round = n % 100 === 0;
    const year = !commas && digits.length === 4 && n >= 1100 && n <= 2999 && !round;
    words.push(...(year ? asYear(n) : cardinal(n)));
    return { words, value: n, decimal: false };
  }
  // `0.5` is said `oh point five` by everyone, and `zero` is the reading of the digit alone
  // elsewhere - so a leading zero before the point is the one place the two differ.
  if (n === 0) words.push("oh"); else words.push(...cardinal(n));
  words.push("point");
  for (const d of fraction) words.push(ONES[Number(d)]);
  return { words, value: n, decimal: true };
}

// A numeral the voice can say, as the words a person would read aloud - or `null` when the
// token is not a numeral this file understands. `null` is the honest answer for a shape it
// does not handle: the caller refuses the token by name instead of inventing a reading.
export function expandNumerals(token) {
  const raw = String(token ?? "");
  if (!raw) return null;

  // A unit written as a symbol is part of the number's meaning, so it is said.
  const money = /^([$£€])(\d[\d,]*(?:\.\d\d)?)$/.exec(raw);
  if (money) {
    const amount = stripNumber(money[2]);
    if (!amount) return null;
    const [one, many] = MONEY[money[1]];
    // Two decimal places is a price in whole units and cents, and a person says `one dollar
    // fifty`, not `one point five zero dollars`. Other decimal places are not a price, so they
    // keep the reading of the number as written.
    const cents = /\.(\d\d)$/.exec(money[2])?.[1];
    // Under one unit the cents are the number: `$0.50` is `fifty cents`, never `oh dollars
    // fifty`, which is a shape nobody says.
    if (cents && amount.value === 0) return [...under100(Number(cents)), cents === "01" ? "cent" : "cents"];
    if (cents && cents !== "00") {
      return [...cardinal(amount.value), amount.value === 1 ? one : many, ...under100(Number(cents))];
    }
    if (cents) return [...cardinal(amount.value), amount.value === 1 ? one : many];
    return [...amount.words, amount.value === 1 ? one : many];
  }
  const percent = /^(.*)%$/.exec(raw);
  if (percent) {
    const amount = stripNumber(percent[1]);
    return amount ? [...amount.words, "percent"] : null;
  }

  const clock = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (clock) {
    const hour = Number(clock[1]), minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    if (minute === 0) return [...under100(hour), "o", "clock"];
    if (minute < 10) return [...under100(hour), "oh", ONES[minute]];
    return [...under100(hour), ...under100(minute)];
  }

  const ordinalForm = /^(\d+)(st|nd|rd|th)$/.exec(raw);
  if (ordinalForm) {
    // The suffix is not trusted to agree with the number: `2st` is a typo, not a reading, and
    // saying `second` for it would hide the typo in audio nobody can proofread.
    const n = Number(ordinalForm[1]);
    if (!suffixAgrees(n, ordinalForm[2])) return null;
    return ordinal(n);
  }

  const decade = /^(\d{3,4})s$/.exec(raw);
  if (decade) {
    const n = Number(decade[1]);
    if (n < 1000 || n > 2999) return null;
    // `1990s` -> nineteen nineties: the last word of the year form takes the plural.
    const words = asYear(n);
    words[words.length - 1] = plural(words[words.length - 1]);
    return words;
  }

  const amount = stripNumber(raw);
  return amount ? amount.words : null;
}

// Does this token start like a numeral? Only used to decide whether the numeral reader is worth
// asking, so a token that merely begins with a digit (`2ndly`, which this file does not handle)
// is still put to it and refused by name rather than skipped.
export const looksNumeric = token => /^[$£€]?\d/.test(String(token ?? ""));
