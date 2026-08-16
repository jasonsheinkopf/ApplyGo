// Company identity: turning the noisy employer strings a job aggregator hands us into a stable
// identity we can deduplicate on, display, and resolve a website from.
//
// Entirely deterministic and dependency-free, on purpose -- this is string shaping, not judgment,
// and every rule here is one a person could read and predict. The LLM/search layer (resolver.ts)
// sits *after* this and only ever sees a cleaned-up name, so it spends its reasoning on genuinely
// ambiguous identity questions rather than on parsing "6010-Biosense Webster Legal Entity".
//
// Three separate outputs, deliberately not collapsed into one:
//
//   sourceName  -- exactly what the aggregator said, never modified. Kept because it's evidence:
//                  when a resolution goes wrong, the original string is the only way to see why.
//   displayName -- what a human should read. Cleaned of source-system artifacts but NOT of the
//                  words that make it a real company name; "Sargent & Lundy LLC." displays as
//                  "Sargent & Lundy", not "sargent lundy".
//   matchKey    -- the aggressive, lossy, lowercase key used ONLY for deduplication. Never shown.
//
// The reason these are three fields instead of one is the bug they replace: the old code had a
// single normalized key doing all three jobs, so improving dedupe meant degrading display, and
// improving display meant weakening dedupe.

/** Legal-entity suffixes. Stripped from the *end* of a name only -- "Corp" in "Corcept" or a
 *  company genuinely called "Company" mid-name must survive. */
const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "l l c", "llp", "lp", "ltd", "limited", "corp", "corporation",
  "co", "plc", "gmbh", "ag", "sa", "sas", "nv", "bv", "ab", "as", "oy", "kk", "pty", "pte",
  "srl", "spa", "kft", "zrt", "doo", "sro", "aps", "sarl", "cv", "kg", "ohg", "eg",
]);

/** Source-system artifacts: text an ATS or aggregator appended that is not part of the employer's
 *  name at all. Matched as whole phrases anywhere in the string. */
const SOURCE_ARTIFACTS = [
  "career site", "careers site", "career portal", "careers portal", "career listing",
  "careers listing", "career opportunities", "job board", "legal entity", "legal entities",
  "external career", "external careers", "talent network", "talent community",
  "requisition", "req id", "us jobs", "job posting",
];

/** Words that are real parts of a company's name but are commonly dropped in its actual domain --
 *  "Green Dot Corporation" -> greendot.com, "SHI International" -> shi.com. Only ever removed from
 *  the *end*, and only to produce extra *domain candidates*, never from the display name. */
const DOMAIN_DROPPABLE_TAIL = new Set([
  "international", "solutions", "systems", "technologies", "technology", "group", "holdings",
  "partners", "services", "consulting", "consultants", "associates", "industries", "enterprises",
  "global", "worldwide", "america", "americas", "usa", "us", "na", "labs", "laboratories",
  "networks", "software", "digital", "ventures", "capital", "management", "companies", "company",
  "brands", "products", "media", "studios", "works",
]);

export type CompanyIdentity = {
  /** Exactly as the source gave it. Never modified. */
  sourceName: string;
  /** Human-readable, artifact-free. What the UI shows. */
  displayName: string;
  /** Lossy lowercase key for dedupe only. Never displayed. */
  matchKey: string;
};

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Removes source-system noise while preserving the actual employer name, including its
 * capitalization, ampersands, and internal punctuation.
 *
 * Handles, in order: a leading numeric entity code ("6010-Biosense Webster"), a trailing
 * "powered by <vendor>" ("JBC powered by WorkGenius"), whole-phrase source artifacts
 * ("CorVel Career Site"), a trailing parenthetical ("Acme (US)"), and finally trailing legal
 * suffixes, repeatedly, so "Sargent & Lundy LLC." and "Foo Inc. Ltd" both reduce correctly.
 */
export function cleanCompanyName(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";

  // "6010-Biosense Webster" / "1234 - Acme" -- an entity/cost-center code, not part of the name.
  // Requires 3+ digits so a genuine name like "3M" or "7-Eleven" is untouched.
  s = s.replace(/^\d{3,}\s*[-–—:]\s*/, "");

  // "JBC powered by WorkGenius" -- the staffing platform, not the employer.
  s = s.replace(/\s*\bpowered by\b.*$/i, "");

  // Whole-phrase source artifacts, anywhere in the string.
  for (const artifact of SOURCE_ARTIFACTS) {
    s = s.replace(new RegExp(`\\b${artifact.replace(/ /g, "\\s+")}\\b`, "gi"), " ");
  }

  // A trailing parenthetical is almost always a region/entity qualifier, not the name.
  s = s.replace(/\s*\([^)]*\)\s*$/, "");

  // Collapse whitespace and strip now-dangling separators before suffix removal.
  s = s.replace(/\s+/g, " ").replace(/^[\s,\-–—.]+|[\s,\-–—]+$/g, "").trim();

  // Trailing legal suffixes, repeatedly. Compare on a punctuation-free lowercase form so "LLC.",
  // "Inc," and "L.L.C." all match, but never drop the last remaining word ("Ltd" alone stays).
  for (;;) {
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length < 2) break;
    const tail = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, "");
    if (!tail || !LEGAL_SUFFIXES.has(tail)) break;
    words.pop();
    s = words.join(" ").replace(/[\s,]+$/, "");
  }

  return s.trim();
}

/**
 * The dedupe key. Aggressive and lossy by design -- this is the only place it's safe to be, since
 * nothing displays it.
 *
 * Deliberately does NOT strip the descriptive words the old companyNameKey did ("group",
 * "technologies", "labs"): those distinguish real, genuinely different employers ("Meta Platforms"
 * vs "Meta Materials", "X Labs" vs "X Group"), and merging them silently was a correctness bug, not
 * a cleanup. Domain guessing still tries dropping them -- see domainCandidates -- but a *guess* is
 * allowed to be wrong in a way an identity merge is not.
 */
export function companyMatchKey(name: string): string {
  return stripAccents(cleanCompanyName(name))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    // Connectors carry no identity and are written inconsistently by different sources -- the real
    // pair "Sargent & Lundy LLC." / "Sargent Lundy" only dedupes once "and" stops counting as a
    // word. Dropping them is safe in a way dropping descriptive words is not: no two distinct
    // employers are told apart by an "and".
    .filter((word) => word && !MATCH_CONNECTORS.has(word))
    .join(" ")
    .trim();
}

/** Connector words dropped from the dedupe key. Never dropped from the display name. */
const MATCH_CONNECTORS = new Set(["and", "of", "the", "for", "at", "in", "a", "an"]);

/** The full identity triple for one raw employer string. */
export function companyIdentity(raw: string): CompanyIdentity {
  const displayName = cleanCompanyName(raw);
  return {
    sourceName: String(raw ?? "").trim(),
    // A name that cleaned away to nothing (e.g. the literal string "Careers Listing") keeps its
    // original text for display -- showing an empty company row would be strictly worse than
    // showing the junk string and letting verification reject it.
    displayName: displayName || String(raw ?? "").trim(),
    matchKey: companyMatchKey(raw),
  };
}

/**
 * True when a name carries no employer-identifying content at all -- it was *entirely* a source
 * artifact ("Careers Listing", "Job Board", "External Careers"). These are ATS page titles that
 * leaked into an employer field, not companies, and creating a company row for one is pure noise.
 *
 * Deliberately narrow: it only fires when cleaning removed everything. A real company whose name
 * merely contains an artifact word ("Career Education Corporation") still cleans to something
 * non-empty and is kept.
 */
export function isNonCompanyName(raw: string): boolean {
  const cleaned = cleanCompanyName(raw);
  if (!cleaned) return true;
  // Nothing but digits/punctuation left is equally meaningless.
  return !/[a-z]/i.test(cleaned);
}

/**
 * Ordered domain-label candidates for a company, best guess first.
 *
 * This is the piece the old resolver was missing entirely: it slugged the *raw* name, so
 * "DocuSign Inc" only ever produced "docusigninc" and never "docusign". Each candidate here is
 * still only a guess -- resolver.ts confirms every one against a real request and real page
 * evidence before it's trusted.
 */
export function domainCandidates(raw: string): string[] {
  const cleaned = stripAccents(cleanCompanyName(raw)).toLowerCase();
  if (!cleaned) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const slug = value.replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
    if (slug.length > 1 && slug.length <= 63 && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  };

  let words = cleaned.split(/[^a-z0-9&]+/).filter(Boolean);
  if (!words.length) return [];

  // Full cleaned name, joined. Also the hyphenated form, which `push` can't produce since it
  // strips separators -- some employers genuinely register one (e.g. "t-mobile.com").
  push(words.join(""));
  const hyphenated = words.filter((w) => w !== "&").join("-");
  if (words.length > 1 && /^[a-z0-9-]{2,63}$/.test(hyphenated) && !seen.has(hyphenated)) {
    seen.add(hyphenated);
    out.push(hyphenated);
  }

  // "Bausch & Lomb" -> "bausch": the part before an ampersand is usually the registered domain.
  const ampIndex = words.indexOf("&");
  if (ampIndex > 0) push(words.slice(0, ampIndex).join(""));

  // Progressively drop generic trailing words: "green dot corporation" -> "greendot",
  // "shi international" -> "shi", "harman international" -> "harman".
  let tail = [...words];
  while (tail.length > 1 && DOMAIN_DROPPABLE_TAIL.has(tail[tail.length - 1])) {
    tail = tail.slice(0, -1);
    push(tail.join(""));
  }

  // Initialism, for names long enough that one is plausible ("University of California Irvine" ->
  // "uci"). Skips connector words so it doesn't produce "uoci".
  const CONNECTORS = new Set(["of", "the", "and", "for", "at", "in", "&"]);
  const significant = words.filter((w) => !CONNECTORS.has(w));
  if (significant.length >= 3) push(significant.map((w) => w[0]).join(""));

  return out;
}

/** TLDs tried against each domain candidate, in descending order of how often they're right for a
 *  US-centric employer set. `.edu` matters more than it looks: universities and medical centers
 *  are a large, systematically-missed slice of the current unresolved set. */
export const DOMAIN_TLDS = ["com", "org", "net", "edu", "io", "ai", "co"];

/**
 * True if two identities are confidently the same employer.
 *
 * Exact match on the dedupe key only. Deliberately NOT fuzzy: the prompt's own example
 * ("a similarly named company in a different location or industry may actually be different")
 * is exactly right, and a false merge is unrecoverable -- it destroys a real company's pipeline --
 * while a false split merely shows a duplicate row a user can merge later. Fuzzier matching
 * belongs behind real evidence (a shared verified domain), which is resolver.ts's job, not a
 * string comparison's.
 */
export function isSameCompany(a: string, b: string): boolean {
  const keyA = companyMatchKey(a);
  const keyB = companyMatchKey(b);
  return keyA.length > 0 && keyA === keyB;
}
