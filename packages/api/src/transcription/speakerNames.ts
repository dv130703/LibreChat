/**
 * Fuzzy matching of roster names against transcribed speech - the "keyword
 * list" half of content-based speaker identification.
 *
 * Exists because ASR mangles proper nouns worse than anything else it
 * transcribes: "Danbury" comes back as "Donbry", "Danbry", "Mauna". Exact
 * string search therefore misses precisely the lines that identify someone.
 *
 * Vowels are what gets mangled - consonants survive - so matching runs on a
 * vowel-stripped skeleton rather than on edit distance over the whole token.
 * A distance threshold loose enough to pair "Donbry" with "Danbury" also
 * pairs unrelated surnames with each other; the skeleton separates them
 * ("mnd" vs "mndr" is one edit, "ptrsn" is nowhere near).
 *
 * Deliberately tuned for recall over precision. Everything here only decides
 * which lines get shown to the identification model as evidence - a spurious
 * line costs a little context, while a missed line can lose the only
 * sentence in an hour of audio that names someone. Precision comes later,
 * from the model plus the evidence-quote verification in `identifySpeakers`.
 */

export interface NameCandidate {
  profileId: string;
  fullName: string;
  role?: string;
}

export interface NameKeyword {
  profileId: string;
  fullName: string;
  /** Normalized single name part - a forename or a surname. */
  token: string;
  skeleton: string;
}

export interface NameMention {
  profileId: string;
  fullName: string;
  /** The token as it actually appears in the transcript, mangling and all -
   *  what makes a mis-transcribed name visible to whoever reads the log. */
  spoken: string;
}

const VOWELS = /[aeiouy]/g;
const NON_LETTERS = /[^a-z]/g;

/** Skeletons this short collide with ordinary speech ("Ed" -> "d" would
 *  match "add", "odd", "aid"), so such names fall back to exact matching. */
const MIN_SKELETON_LENGTH = 3;

function normalize(token: string): string {
  return token.toLowerCase().replace(NON_LETTERS, '');
}

/** Consonant skeleton: vowels dropped, then runs of a repeated consonant
 *  collapsed, so "Patterson" and "Paterson" reduce identically. */
function consonantSkeleton(normalized: string): string {
  const consonants = normalized.replace(VOWELS, '');
  let skeleton = '';
  for (const character of consonants) {
    if (character !== skeleton[skeleton.length - 1]) {
      skeleton += character;
    }
  }
  return skeleton;
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const substitution = previous[j] + (a[i] === b[j] ? 0 : 1);
      current.push(Math.min(substitution, previous[j + 1] + 1, current[j] + 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Whether a token heard in the transcript plausibly refers to `keywordToken`
 * (an already-normalized roster name part).
 */
export function spokenTokenMatches(spoken: string, keywordToken: string): boolean {
  const normalized = normalize(spoken);
  if (normalized.length === 0) {
    return false;
  }
  if (normalized === keywordToken) {
    return true;
  }

  const spokenSkeleton = consonantSkeleton(normalized);
  const keywordSkeleton = consonantSkeleton(keywordToken);
  if (spokenSkeleton.length < MIN_SKELETON_LENGTH || keywordSkeleton.length < MIN_SKELETON_LENGTH) {
    return false;
  }
  return levenshtein(spokenSkeleton, keywordSkeleton) <= 1;
}

/**
 * Each roster name broken into independently searchable parts, because
 * interviews rarely use a full name twice - the first reference is "Rowan
 * Danbury", every one after it is "Rowan" or "Mr Danbury".
 */
export function buildNameKeywords(candidates: NameCandidate[]): NameKeyword[] {
  const keywords: NameKeyword[] = [];
  for (const candidate of candidates) {
    const seen = new Set<string>();
    for (const part of candidate.fullName.split(/\s+/)) {
      const token = normalize(part);
      if (token.length === 0 || seen.has(token)) {
        continue;
      }
      seen.add(token);
      keywords.push({
        profileId: candidate.profileId,
        fullName: candidate.fullName,
        token,
        skeleton: consonantSkeleton(token),
      });
    }
  }
  return keywords;
}

/** Every roster person plausibly named in one line, each reported once
 *  however many of their name parts the line happens to contain. */
export function findNameMentions(text: string, keywords: NameKeyword[]): NameMention[] {
  const mentions = new Map<string, NameMention>();
  for (const spoken of text.split(/[^A-Za-z']+/)) {
    if (spoken.length === 0) {
      continue;
    }
    for (const keyword of keywords) {
      if (mentions.has(keyword.profileId) || !spokenTokenMatches(spoken, keyword.token)) {
        continue;
      }
      mentions.set(keyword.profileId, {
        profileId: keyword.profileId,
        fullName: keyword.fullName,
        spoken,
      });
    }
  }
  return Array.from(mentions.values());
}
