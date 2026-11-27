// How a written number becomes words a listener can follow.
//
// The defect this exists for, measured on the build before it:
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
// (`3/4/2024`), a suffix glued to a number (`$5M`, `2.5x`) and a misplaced ordinal suffix
// (`2st`). They keep failing loudly, with the same refusal as before, because a wrong guess
// about a date or a magnitude is a sentence that is confidently about a different one.
//
// ## The second round: four ways the first version changed what a line meant
//
// The first reading (`cmudict-3`) was listened to on ordinary lines and got the meaning wrong
// four times. Every one of them was measured on the build that shipped it:
//
//   "The ticket costs $1250."      "twelve fifty dollars" - the price path read the digits as a
//                                  year, so twelve hundred fifty became twelve fifty
//   "It costs £0.50."              "fifty cents" - the unit was dropped and replaced by another
//                                  currency's subunit, so a pound was said as cents
//   "1,000,000,000,000 dollars"    "one dollars" - the scale table stopped at a billion and the
//                                  rest of the number was lost without a sound
//   "It is -3.5 degrees."          "three point five" - the sign went with the punctuation, so a
//                                  cold line was read as a warm one
//
// A number whose reading changes the meaning is worse than one that is refused, because the
// listener has no way to notice. So the rules now are:
//
//   * money is read as money, never as a year: `$1250` is `one thousand two hundred fifty
//     dollars`;
//   * a currency's own subunit is used: `£0.50` is `fifty pence`, `$0.50` is `fifty cents`;
//   * a magnitude this file cannot name is refused, not truncated (`cardinal` returns null past
//     trillions, and the token is then refused by name like any other shape it does not know);
//   * a leading `+` or `-` is said: `-3.5` is `minus three point five`, and `-3.5%` is `minus
//     three point five percent`. The writer's own words say whether it is degrees or dollars;
//     the sign is the part this file must not drop.
//
// None of this changes what an existing recording sounds like. `cmudict-3` keeps every reading
// above to the sample, including the four wrong ones, because a take made with it must still
// reproduce from the table that made it. The corrected readings ship as `cmudict-4`; the sets
// older than the numeral reader keep their digit-by-digit reading as they always have.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
// `trillion` is the last scale name this file has, and the last one an amount of money or a
// quantity is normally written in. Above it the token is refused rather than cut short.
const SCALES = ["", "thousand", "million", "billion", "trillion"];
// The table `cmudict-3` shipped with. Kept as data, not as a comment, because a take made with
// that table must keep reproducing: its `1,000,000,000,000` really is the word "one".
const LEGACY_SCALES = SCALES.slice(0, 4);

const under100 = n => n < 20 ? [ONES[n]] : n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[Math.floor(n / 10)]];

// From 0 upwards, without "and".
//
// `scales` and `truncate` exist only to keep `cmudict-3` byte-identical: that set shipped with a
// table that stopped at `billion` and dropped the rest of the number without a sound, so
// `1,000,000,000,000` was said as "one". A take made with it must keep reproducing that (wrong)
// reading. Every current caller uses the full table and `truncate: false`, which makes a
// magnitude past the last name a refusal rather than a lie.
export function cardinal(n, scales = SCALES, truncate = false) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return ["zero"];
  const groups = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  if (groups.length > scales.length && !truncate) return null;
  const words = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (!group) continue;
    if (group >= 100) {
      words.push(ONES[Math.floor(group / 100)], "hundred");
      if (group % 100) words.push(...under100(group % 100));
    } else words.push(...under100(group));
    if (scales[i]) words.push(scales[i]);
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

// Each currency says its own subunit. Saying `cents` for `£0.50` is not a rounding error, it is
// a different sentence: a pound is not a hundred cents, and a listener who hears "cents" has
// been told about money in the wrong country.
const MONEY = {
  $: { one: "dollar", many: "dollars", cent: "cent", cents: "cents" },
  "£": { one: "pound", many: "pounds", cent: "penny", cents: "pence" },
  "€": { one: "euro", many: "euros", cent: "cent", cents: "cents" }
};

// One written number, with the decisions above applied. `value`, `decimal` and `places` come
// back too, because a unit's singular or plural depends on them ("one dollar", "two dollars")
// and so does whether a fractional amount is a price or a number read aloud.
//
// `options.scales` is passed straight through to `cardinal` and exists for the one frozen set
// that has to keep its old, lossy reading. `options.year` is off for money: `$1250` is twelve
// hundred fifty dollars, and reading its digits as a year turned it into twelve fifty.
function stripNumber(text, options = {}) {
  const scales = options.scales ?? SCALES;
  const negative = text.startsWith("-");
  const positive = text.startsWith("+");
  const body = negative || positive ? text.slice(1) : text;
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
  else if (positive) words.push("plus");
  if (fraction == null) {
    // A year only when written without a separator, in the range people write years in - and
    // only when it is not a round hundred or a round thousand. `1200` in prose is a count and
    // is said `one thousand two hundred`; `1200 BC` would want `twelve hundred`, but the year
    // reading of a bare four-digit number is the more common one only inside a real year range.
    const round = n % 100 === 0;
    const year = options.year !== false && !commas && digits.length === 4 && n >= 1100 && n <= 2999 && !round;
    const number = year ? asYear(n) : cardinal(n, scales, options.truncate === true);
    if (!number) return null;
    words.push(...number);
    return { words, value: n, decimal: false, fraction: null, places: 0 };
  }
  // `0.5` is said `oh point five` by everyone, and `zero` is the reading of the digit alone
  // elsewhere - so a leading zero before the point is the one place the two differ.
  const number = n === 0 ? ["oh"] : cardinal(n, scales, options.truncate === true);
  if (!number) return null;
  words.push(...number);
  words.push("point");
  for (const d of fraction) words.push(ONES[Number(d)]);
  return { words, value: n, decimal: true, fraction, places: fraction.length };
}

// The words of an amount of money, with the currency's own subunit when the written amount has
// exactly two decimal places - which is what a price in a currency with hundredths looks like.
function moneyWords(amount, unit, options) {
  const { value, fraction, places } = amount;
  // The sign, when there is one, is said before the amount in every shape below.
  const sign = amount.words[0] === "minus" || amount.words[0] === "plus" ? [amount.words[0]] : [];
  const whole = () => cardinal(value, options.scales, options.truncate === true) ?? [];
  // Singular only for exactly one whole unit. `$1.50` is "one dollar fifty" - the unit is still
  // singular because there is one of them - but `$1.234` is "one point two three four
  // dollars", where the amount is not one dollar at all.
  const unitWord = places === 0 && value === 1 ? unit.one : unit.many;
  if (!amount.decimal) return [...amount.words, unitWord];
  const minor = places === 2 && fraction != null ? Number(fraction) : null;
  // Under one whole unit the subunit is the number: `$0.50` is `fifty cents`, never `oh dollars
  // fifty`, which is a shape nobody says.
  if (minor != null && value === 0) {
    const cents = cardinal(minor, options.scales, options.truncate === true) || under100(minor);
    return [...sign, ...cents, minor === 1 ? unit.cent : unit.cents];
  }
  // A price with hundredths: `$1.50` is `one dollar fifty`, which is how a person reads it. Two
  // place values of zero are still whole units (`$1.00` is `one dollar`).
  // `$1.50` is "one dollar fifty": the unit stays singular because there is one of them, and
  // the cents are said after it. `$2.50` is "two dollars fifty" for the same reason.
  if (minor != null && minor !== 0) return [...sign, ...whole(), value === 1 ? unit.one : unit.many, ...under100(minor)];
  // Exactly two decimal places ending in `00` is whole units: `$1.00` is `one dollar`, not `one
  // point zero zero dollar`. The number's own words are not reused here because they include
  // the spoken point.
  if (minor === 0) return [...sign, ...whole(), value === 1 ? unit.one : unit.many];
  // Any other number of decimal places is not a price in hundredths, so it keeps the reading of
  // the number as written: `$1.234` is `one point two three four dollars`. Faithful to the
  // written amount is the whole job here; guessing a rounding would be inventing figures.
  return [...amount.words, unitWord];
}

// A numeral the voice can say, as the words a person would read aloud - or `null` when the
// token is not a numeral this file understands. `null` is the honest answer for a shape it
// does not handle: the caller refuses the token by name instead of inventing a reading.
//
// `readings` names the table asking, and it is not decoration: `cmudict-3` must keep the four
// readings listed at the top of this file to the sample, because a take published with it is
// that recording. Only `cmudict-4` and later get the corrections.
export function expandNumerals(token, readings = "cmudict-4") {
  const written = String(token ?? "");
  if (!written) return null;
  const legacy = readings === "cmudict-3";
  // The shipped reader had no reading for a leading plus at all (`+5` was refused), so the
  // frozen table keeps refusing it. A take made with it cannot contain a `plus`, which is
  // exactly why reproducing "refused" matters here and reproducing a guess would not.
  if (legacy && /^[+]/.test(written)) return null;
  // A pasted true minus is a minus. The frozen set never accepted it either - it stripped it and
  // read the digits as positive - so only the strict sets get this reading.
  const raw = legacy ? written : written.replaceAll(PASTED_MINUS, "-");
  const options = legacy ? { scales: LEGACY_SCALES, truncate: true } : { scales: SCALES };

  // A unit written as a symbol is part of the number's meaning, so it is said. The sign comes
  // before the symbol when a person writes `-$5`, so it is matched here rather than left to the
  // bare-number path, which cannot parse a currency symbol and would drop it.
  const money = /^([+-]?)([$£€])(.*)$/.exec(raw);
  if (money) {
    // An amount of money is never a year: `$1250` is twelve hundred fifty dollars. The year
    // reading is right for a bare four-digit count of years and wrong for a price, and money is
    // the one shape where the writer has already said which kind of number this is.
    const amount = stripNumber(money[3], legacy ? options : { ...options, year: false });
    if (!amount) return null;
    // `-$5` carries its sign outside the number, so it is put in front of the words here.
    if (money[1]) amount.words.unshift(money[1] === "-" ? "minus" : "plus");
    if (legacy) {
      // The shipped `cmudict-3` readings, kept exactly: the price path reads the whole part as a
      // year (`$1250` -> `twelve fifty`) and always uses the dollar subunit. Both are wrong and
      // both are frozen, because a take made with this table sounds like this. A price with any
      // other number of decimal places was refused outright, and still is.
      if (!/^\d[\d,]*(?:\.\d\d)?$/.test(money[3])) return null;
      const [one, many] = [MONEY[money[2]].one, MONEY[money[2]].many];
      const cents = /\.(\d\d)$/.exec(money[3])?.[1];
      if (cents && amount.value === 0) return [...under100(Number(cents)), cents === "01" ? "cent" : "cents"];
      if (cents && cents !== "00") return [...cardinal(amount.value, LEGACY_SCALES, true), amount.value === 1 ? one : many, ...under100(Number(cents))];
      if (cents) return [...cardinal(amount.value, LEGACY_SCALES, true), amount.value === 1 ? one : many];
      return [...amount.words, amount.value === 1 ? one : many];
    }
    return moneyWords(amount, MONEY[money[2]], options);
  }
  const percent = /^(.*)%$/.exec(raw);
  if (percent) {
    const amount = stripNumber(percent[1], options);
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

  const amount = stripNumber(raw, options);
  return amount ? amount.words : null;
}

// Does this token start like a numeral? Only used to decide whether the numeral reader is worth
// asking, so a token that merely begins with a digit (`2ndly`, which this file does not handle)
// is still put to it and refused by name rather than skipped.
export const looksNumeric = token => /^[$£€+-]?\d/.test(String(token ?? ""));

// ## Symbols pasted from a page
//
// A script is usually copied out of a document, and a document uses characters a keyboard does
// not: a real minus sign, a yuan sign, a half. Those are not edge cases, they are what happens
// when somebody writes a line about prices or temperatures and pastes it in.
//
// Two rules, and the difference between them is whether the reading is a guess:
//
//   * U+2212 MINUS SIGN is unambiguously a minus, so it is *read* as one (`−3.5` is minus three
//     point five). Refusing it would be pedantry about a character whose whole meaning is known.
//   * A currency this voice does not name, a fraction symbol, or a mathematical operator each
//     carry meaning that would be *lost* if the character were dropped or read as its digits.
//     `¥500` said as "five hundred" is a price in the wrong currency - the same defect as `£0.50`
//     said as cents, which a listener reported. So these are refused, and refused *by name*: the
//     message says which symbol and what to write instead, because a refusal is something the
//     writer can act on.
const OTHER_CURRENCIES = "¥₹₩₽₺₪₫₴₦₱฿₡₲₵₸₼₾₿₼";
const FRACTION_SYMBOLS = "½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒⅟";
const OPERATOR_SYMBOLS = "×÷±√≈≠≤≥∞∑∏∫∂";
// `3.5°` lost the degrees and `1990–1995` lost the range: both were dropped as punctuation and
// the line was read without them. A degree sign is a unit and a dash between two numbers is a
// span, and neither is recoverable by a listener who was never told it was there.
const UNIT_AND_RANGE_SYMBOLS = "°\u2013\u2014~→";
// The minus sign people actually paste. En and em dashes are deliberately not included: they are
// what a range is written with (`1990–1995`), and reading one as a minus would turn a span of
// years into a subtraction.
export const PASTED_MINUS = "\u2212";

// Why a token cannot be said, in the words the writer needs. `null` when every symbol in it is
// one this reader understands.
export function unsupportedSymbols(token) {
  const raw = String(token ?? "");
  const reasons = [];
  for (const ch of raw) {
    if (ch === PASTED_MINUS) continue;
    if (OTHER_CURRENCIES.includes(ch)) reasons.push(`${ch} is a currency this voice does not name (it reads $, £ and €)`);
    else if (FRACTION_SYMBOLS.includes(ch)) reasons.push(`${ch} is a fraction symbol (write the fraction out, or as words)`);
    else if (OPERATOR_SYMBOLS.includes(ch)) reasons.push(`${ch} is a mathematical symbol`);
    else if (UNIT_AND_RANGE_SYMBOLS.includes(ch)) reasons.push(`${ch} is a unit or range symbol (write the unit, or \"to\" for a range)`);
  }
  return reasons.length ? [...new Set(reasons)] : null;
}
