// AI-writing anti-list for Filings editorial output.
//
// Sourced from: Wikipedia "Signs of AI writing"; Kobak et al 2024 PubMed excess-vocabulary study;
// FSU "Delve" paper; Pangram stylistic-fingerprint study (DeepSeek-R1 classified as GPT-family 74%
// of the time, inherits GPT-4-era markers); Bloomberg/Reuters/FT style guides.
//
// Three layers:
//   1. PHRASE_PATTERNS — case-insensitive regex; one match = one violation.
//   2. STRUCTURAL_RULES — functions over the assembled prose; return {name, evidence} on violation.
//   3. SOURCE_FIDELITY (in enricher.mjs validator) — number fingerprinting against source.

// ─── Layer 1 — phrase patterns ────────────────────────────────────────

// Original set (kept as-is, anchors the historical behavior of the validator)
const ORIGINAL = [
  /\bit is worth noting\b/i,
  /\bit should be emphasi[sz]ed\b/i,
  /\bimportantly,\b/i,
  /\bnotably,\b/i,
  /\bof course,\b/i,
  /\bin conclusion\b/i,
  /\bto summari[sz]e\b/i,
  /\bgoing forward\b/i,
  /\bmoving forward\b/i,
  /\bin recent months\b/i,
  /\bin today'?s (fast-paced|environment|landscape)\b/i,
  /\bsome analysts believe\b/i,
  /\bindustry experts have noted\b/i,
  /\bmany believe\b/i,
  /\bit is believed\b/i,
  /\bmay potentially\b/i,
  /\bcould potentially\b/i,
  /\bpursuant to\b/i,
  /\bas per the (filing|disclosure)\b/i,
  /\bfiled with (the )?exchange/i,
  /\bin a regulatory filing\b/i,
  /\bin the (latest|recent) filing\b/i,
  /\bgame[- ]changing\b/i,
  /\btransformative\b/i,
  /\brevolutionary\b/i,
  /\bleverag(e|ing|es)\b/i,
  /\bnavigat(e|ing|es) the\b/i,
  /\bunlock(s|ing)? (potential|value|growth)\b/i,
  /\bempower(s|ing)?\b/i,
  /\binvestors? (will|may|are likely to|expect|view|see this as)\b/i,
  /\bthe market (reaction|will|expects|sentiment|thinks)\b/i,
  /\bmarket reaction (moderate|muted|positive|negative)\b/i,
  /\bthe street (thinks|expects|believes|sees)\b/i,
  /\bshares? (will|may|are likely to) (rally|fall|rise|drop|jump|slip)\b/i,
  /\bstock (to|will|may) (react|move|trade|rally|fall)\b/i,
  /\bin the (transcript|filing|disclosure|press release)\b/i,
  /\bper the (filing|disclosure)\b/i,
  /\bas (recorded|noted) in the (transcript|filing)\b/i,
];

// Tier 1 — the "underscores" family + AI-academic high-density vocabulary.
// These are the single most concentrated AI tells in DeepSeek output per Pangram research.
const TIER1_AI_VERBS_AND_NOUNS = [
  // "underscores" family — passive emphasis without an emphasizer
  /\bunderscor(e|es|ed|ing)\b/i,
  /\bhighlight(s|ed|ing)?\b(?!\s+reel)/i,    // allow "highlight reel" but not the verb
  /\bshowcas(e|es|ed|ing)\b/i,
  /\bemphasi[sz](e|es|ed|ing)\b/i,
  /\bexemplif(y|ies|ied)\b/i,
  /\bepitomiz(e|es|ed)\b/i,
  /\bencapsulat(e|es|ed)\b/i,
  /\btypif(y|ies|ied)\b/i,
  /\b(?:stands?|serves?|functions?|acts?) as (a|an|the) [a-z]+/i,  // "serves as a testament", copula avoidance
  /\b(?:stands?|serves?) as a testament\b/i,
  /\bspeaks? to (?:the|a) /i,                                       // "speaks to the importance of"

  // Top AI vocab
  /\bpivotal( role| moment)?\b/i,
  /\bcrucial(ly)?\b/i,
  /\brobust\b/i,
  /\bcomprehensive\b/i,
  /\bseamless(ly)?\b/i,
  /\bintricate(ly)?\b/i,
  /\bintricacies\b/i,
  /\bdelv(e|es|ed|ing) into\b/i,
  /\b(?:in the|the) realm of\b/i,
  /\b(?:in the|the) (?:ever-evolving|ever-changing) (?:landscape|world)\b/i,
  /\bnavigat(?:e|es|ing) the (?:complex |intricate |evolving )?(?:landscape|environment|terrain|complexities)\b/i,
  /\btapestry\b/i,
  /\bvibrant\b/i,
  /\bmeticulous(ly)?\b/i,
  /\bmyriad\b/i,
  /\bplethora\b/i,
  /\bcompelling\b/i,
  /\bcommendable\b/i,
  /\bremarkable\b/i,
  /\bharness(es|ing|ed)?\b/i,
  /\bgarner(s|ed|ing)?\b/i,
  /\bbolster(s|ed|ing)?\b/i,
  /\bfoster(s|ed|ing)?\b/i,
  /\bpropel(s|led|ling)?\b/i,
  /\bresonat(e|es|ed|ing) with\b/i,

  // Transitions — top three AI fingerprints
  /\bmoreover,?\b/i,
  /\bfurthermore,?\b/i,
  /\badditionally,?\b/i,
  /\bconsequently,?\b/i,
  /\bsubsequently,?\b/i,
  /\bnonetheless,?\b/i,
  /\bnevertheless,?\b/i,
  /\bhence,?\b/i,
  /\bthus,?\b/i,
  /\bindeed,\b/i,
  /\binterestingly,\b/i,
  /\btellingly,\b/i,
  /\bstrikingly,\b/i,

  // Wrap fillers
  /\bin essence\b/i,
  /\bin summary\b/i,
  /\bto sum up\b/i,
  /\bultimately,?\b/i,
  /\boverall,?\b/i,
  /\bas (?:we|one) (?:can|might) see\b/i,
  /\bas (?:discussed|mentioned|noted) (?:above|earlier|previously)\b/i,

  // "Testament", "reminder", "beacon" cliché templates
  /\b(?:a|the) testament to\b/i,
  /\bstands? as a (?:powerful |stark |lasting |key )?(?:testament|reminder|symbol|example|monument)\b/i,
  /\b(?:a|the) (?:powerful|stark|gentle|timely) reminder\b/i,
  /\b(?:a|the) beacon of\b/i,
  /\b(?:a|the) cornerstone of\b/i,
  /\bat the (?:heart|forefront) of\b/i,
  /\bat its core\b/i,

  // Openers / closers
  /\bembark(?:s|ed|ing)? on (?:a|an|the) (?:journey|exploration|adventure)\b/i,
  /\b(?:let'?s |let us |we'?ll |we will )?(?:dive|delve) into\b/i,
  /\b(?:a|the) deep dive\b/i,
  /\bpicture this\b/i,
  /\bbuckle up\b/i,
  /\btime will tell\b/i,
  /\bonly time will tell\b/i,
  /\bcannot be overstated\b/i,
];

// Tier 2 — financial-domain template phrases. These appear specifically in business-news AI output.
const TIER2_FINANCIAL_FILLER = [
  /\bstrategically positioned to (?:capitali[sz]e|benefit|leverage)\b/i,
  /\bwell-positioned to (?:benefit|capitali[sz]e|leverage|capture)\b/i,
  /\bpositions? (?:the company|the firm|itself|the bank) (?:for|to)\b/i,
  /\bmarks? (?:a|an) (?:significant|major|important|key) milestone\b/i,
  /\bunderscor(?:es|ed) management'?s commitment\b/i,
  /\breaffirms? management'?s (?:confidence|commitment|guidance)\b/i,
  /\b(?:reflects?|underscor(?:es|ed)|highlights?) management'?s (?:focus|strategy|vision|commitment|discipline)\b/i,
  /\bpoised to (?:benefit|capitali[sz]e|grow|deliver|expand|capture)\b/i,
  /\bset to (?:benefit|capitali[sz]e|deliver|drive|capture)\b/i,
  /\b(?:could|may) pave the way for\b/i,
  /\bpaves? the way (?:for|to)\b/i,
  /\b(?:represents?|marks?) (?:a|an) (?:pivotal|key|major|important) (?:shift|turning point|inflection)\b/i,
  /\b(?:industry|market) (?:observers|participants|experts) (?:are likely to|have noted|believe|expect)\b/i,
  /\banalysts (?:expect|believe|note|are likely to|have flagged|are watching)\b(?! [A-Z])/i,  // unless followed by capital (name)
  /\bvalue[- ]accretive\b/i,
  /\beps[- ]accretive\b/i,
  /\boperational discipline\b/i,
  /\bexecution discipline\b/i,
  /\boperational momentum\b/i,
  /\bsecular tailwind\b/i,
  /\bstructural tailwind\b/i,
  /\bmargin expansion\b(?!\s+of)/i,                      // OK if quantified ("margin expansion of 280 bps")
  /\boperating leverage\b(?!\s+(?:on|of|from|gives))/i,  // OK if explained
  /\b(?:K-?shaped|V-?shaped|U-?shaped) (?:recovery|economy)\b/i,
  /\bgreen shoots\b/i,
  /\bthe (?:next|new) (?:Amazon|Apple|Google|Microsoft|Tesla|Reliance|TCS)\b/i,
  /\bUber for\b/i,
  /\binflection point\b/i,
  /\bbottom(?:ed|ing) out\b/i,
  /\bturn(?:ed|ing|s)? the corner\b/i,
  /\b(?:the )?worst is (?:behind us|over)\b/i,
  /\bsea change\b/i,
];

// Tier 4 — DeepSeek-specific suspects. Lower priority but cheap to add.
const TIER4_DEEPSEEK_SUSPECTS = [
  /\bshed(s|ding) light on\b/i,
  /\billuminat(e|es|ed|ing)\b/i,
  /\barguably\b/i,
  /\bmultifaceted\b/i,
  /\bnuanced(ly)?\b/i,
  /\binterplay\b/i,
  /\bsynergy\b/i,
  /\bsynergies\b/i,
  /\bsymbiosis\b/i,
  /\bsymbioses\b/i,
  /\bsuper-?charg(e|es|ed|ing)\b/i,
  /\bturbo-?charg(e|es|ed|ing)\b/i,
  /\bunleash(es|ed|ing)?\b/i,
  /\bfuture[- ]proof\b/i,
  /\bbest-in-class\b/i,
  /\bworld-class\b/i,
  /\bnext-generation\b/i,
  /\bparadigm shift\b/i,
  /\bparadigm[- ]shifting\b/i,
];

export const PHRASE_PATTERNS = [
  ...ORIGINAL,
  ...TIER1_AI_VERBS_AND_NOUNS,
  ...TIER2_FINANCIAL_FILLER,
  ...TIER4_DEEPSEEK_SUSPECTS,
];

// ─── Layer 2 — structural rules ───────────────────────────────────────

// "not just X, but Y" / "not only X but also Y" / "it's not X, it's Y" — the negative-parallelism
// family. Every modern LLM falls back on this under instruction-following pressure.
const NEGATIVE_PARALLELISM = /\bnot (?:just|only|merely|simply)[^.\n]{1,80}\bbut(?: also)?\b/i;

// "X — not just Y, but Z" — em-dashed variant
const EM_DASH_PARALLELISM = /—[^—\n]{1,80}\bnot (?:just|only|merely|simply)[^—\n]{1,80}—/i;

// Em-dash density check — more than one em-dash per 150 words signals overuse.
function emDashOveruse(text) {
  const words = text.split(/\s+/).length;
  const emDashes = (text.match(/—/g) || []).length;
  const allowed = Math.max(1, Math.floor(words / 150));
  if (emDashes > allowed) {
    return { name: 'em_dash_overuse', evidence: `${emDashes} em-dashes in ${words} words (max ${allowed})` };
  }
  return null;
}

// Three-adjective list: "X, Y, and Z" where all three are adjectives. Heuristic: comma-separated
// triplet ending in "and" + adjective, all words ending in common adj suffixes or being a short
// abstract qualifier.
const ADJ_HINT = /\b(?:robust|scalable|intuitive|strong|comprehensive|seamless|innovative|dynamic|agile|resilient|flexible|sustainable|effective|efficient|powerful|holistic|integrated|nimble)\b/i;
function adjTripletOveruse(text) {
  const matches = text.match(/(\w+),\s+(\w+),?\s+and\s+(\w+)/gi) || [];
  const triplets = matches.filter(m => {
    const parts = m.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 4) return false;
    return ADJ_HINT.test(parts[0]) && ADJ_HINT.test(parts[1]) && ADJ_HINT.test(parts[3]);
  });
  if (triplets.length > 0) {
    return { name: 'three_adjective_list', evidence: triplets[0] };
  }
  return null;
}

// Paragraph-opening adverb: "Notably," / "Importantly," / "Crucially," etc. at the start of any
// sentence inside the_full_read.
const PARA_OPEN_ADVERBS = /(?:^|[.!?]\s+)(?:Notably|Importantly|Crucially|Ultimately|Essentially|Fundamentally|Significantly|Substantially|Predictably|Unsurprisingly|Tellingly|Strikingly|Interestingly|Indeed),/g;
function paragraphOpeningAdverbs(text) {
  const hits = text.match(PARA_OPEN_ADVERBS);
  if (hits && hits.length > 0) {
    return { name: 'sentence_opening_adverb', evidence: hits[0].trim() };
  }
  return null;
}

// Burstiness: standard deviation of sentence-length should be > 6 words for human-feeling prose.
// AI clusters at SD 2-4. Apply only to the_full_read (the only field long enough for the metric
// to be meaningful — 120-200 words).
function burstinessCheck(fullRead) {
  const sents = String(fullRead || '').split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  if (sents.length < 4) return null;  // too few sentences to assess
  const lengths = sents.map(s => s.split(/\s+/).length);
  const mean = lengths.reduce((a,b) => a+b, 0) / lengths.length;
  const variance = lengths.reduce((a,b) => a + (b - mean) ** 2, 0) / lengths.length;
  const sd = Math.sqrt(variance);
  if (sd < 5) {
    return { name: 'monotone_sentence_lengths', evidence: `SD=${sd.toFixed(2)} (target >5; aim for 8+)` };
  }
  return null;
}

// Mandatory summary close: last sentence of the_full_read begins with "In conclusion" / "In essence"
// / "Overall" / "Ultimately" / "All in all" — already caught by PHRASE_PATTERNS but flag explicitly
// for clarity in feedback message.
function summaryClose(fullRead) {
  const m = String(fullRead || '').trim().match(/(?:^|\.\s+)(In conclusion|In essence|In summary|Overall|Ultimately|All in all|To sum up|To conclude)\b[^.]*\.?\s*$/i);
  if (m) return { name: 'summary_close', evidence: m[1] };
  return null;
}

// Magnitude fidelity: "halved/doubled/tripled" must match the percentage it sits next to. The
// model occasionally reaches for a round magnitude word ("halved") when the real change is
// something else ("34%"). High precision: fires only when a contradicting % sits within ~40 chars
// of the word — never when the change is given in absolute terms, or when the % agrees.
const MAGNITUDE_TARGETS = [
  [/\bhalv(?:e|ed|es|ing)\b/i, 50],
  [/\bdoubl(?:e|ed|es|ing)\b/i, 100],
  [/\btripl(?:e|ed|es|ing)\b/i, 200],
  [/\bquadrupl(?:e|ed|es|ing)\b/i, 300],
];
function magnitudeContradiction(text) {
  const s = String(text || '');
  for (const [re, target] of MAGNITUDE_TARGETS) {
    const m = re.exec(s);
    if (!m) continue;
    const window = s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    const pcts = [...window.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(x => parseFloat(x[1]));
    if (pcts.length && !pcts.some(p => Math.abs(p - target) <= 7)) {
      return { name: 'magnitude_mismatch', evidence: `"${m[0]}" near ${pcts.join('/')}% (expected ~${target}%)` };
    }
  }
  return null;
}

// The_full_read must end on a declarative verdict, never a rhetorical question — a prompt rule the
// regex layer never enforced. Flag a trailing "?".
function rhetoricalQuestionEnding(fullRead) {
  const t = String(fullRead || '').trim();
  if (/\?\s*$/.test(t)) return { name: 'rhetorical_question_ending', evidence: t.slice(-60) };
  return null;
}

export const STRUCTURAL_RULES = [
  (text, { full_read }) => NEGATIVE_PARALLELISM.test(text)
    ? { name: 'negative_parallelism', evidence: text.match(NEGATIVE_PARALLELISM)?.[0] } : null,
  (text) => EM_DASH_PARALLELISM.test(text)
    ? { name: 'em_dashed_parallelism', evidence: text.match(EM_DASH_PARALLELISM)?.[0] } : null,
  (text) => emDashOveruse(text),
  (text) => adjTripletOveruse(text),
  (text) => paragraphOpeningAdverbs(text),
  (_text, { full_read }) => burstinessCheck(full_read),
  (_text, { full_read }) => summaryClose(full_read),
  (text) => magnitudeContradiction(text),
  (_text, { full_read }) => rhetoricalQuestionEnding(full_read),
];

// ─── Suggested substitutions used in the feedback retry ────────────────

export const FEEDBACK_SUBSTITUTIONS = [
  ['underscores / highlights / showcases / emphasizes',
   'name what specifically changed; quote the number that proves the point. Do not use abstractions as agents.'],
  ['"not just X, but Y" / "not only X, but also Y"',
   'pick one — say what is true. The negative-parallelism construction is the single most reliable AI tell.'],
  ['pivotal / crucial / robust / comprehensive / seamless / intricate',
   'replace with the specific evidence. "Crucial" = "the cost the company cannot pass through". "Robust" = "₹X cr cushion".'],
  ['delve into / dive into / deep dive / embark on a journey',
   'just start with the news.'],
  ['moreover / furthermore / additionally',
   'use "But", "And", "Also", or no connector. AI sprinkles formal transitions; humans break sentences.'],
  ['in conclusion / in essence / in summary / overall / ultimately',
   'end on the verdict. No recap. The reader can scroll up.'],
  ['underscores management\'s commitment / reaffirms management\'s confidence / well-positioned / poised to',
   'name the action: "Management raised guidance to X". "Spent ₹X cr on Y". Verbs, not posture.'],
  ['leverage / harness / navigate / unlock / empower',
   'use, draw on, tap, work through, give, allow.'],
  ['investors / market / analysts / Street (without a named source)',
   '"The open question is X". "The next test is Y". Describe the situation, not who will think what.'],
];
