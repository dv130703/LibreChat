import { buildNameKeywords, findNameMentions, spokenTokenMatches } from './speakerNames';

describe('spokenTokenMatches', () => {
  it('matches the same name regardless of case and punctuation', () => {
    expect(spokenTokenMatches('Danbury,', 'danbury')).toBe(true);
    expect(spokenTokenMatches('"VELKIN"', 'velkin')).toBe(true);
  });

  /** The whole reason this module exists: Whisper mangles proper nouns, and
   *  it mangles vowels far more than consonants. A plain edit-distance
   *  threshold loose enough to catch "Donbry" for "Danbury" is loose enough
   *  to catch unrelated surnames too, so the consonant skeleton carries the
   *  match instead. */
  it('matches a name whose vowels the transcriber mangled', () => {
    expect(spokenTokenMatches('Donbry', 'danbury')).toBe(true);
    expect(spokenTokenMatches('Danbry', 'danbury')).toBe(true);
    expect(spokenTokenMatches('Voelkin', 'velkin')).toBe(true);
  });

  it('rejects unrelated names', () => {
    expect(spokenTokenMatches('Patterson', 'danbury')).toBe(false);
    expect(spokenTokenMatches('Wellington', 'velkin')).toBe(false);
    expect(spokenTokenMatches('thanks', 'velkin')).toBe(false);
  });

  /** A two-consonant skeleton collides with far too much ordinary speech -
   *  "Ed" would match "add", "odd", "aid". Short names must be exact. */
  it('requires an exact match for names too short to have a distinctive skeleton', () => {
    expect(spokenTokenMatches('Ed', 'ed')).toBe(true);
    expect(spokenTokenMatches('Ade', 'ed')).toBe(false);
    expect(spokenTokenMatches('add', 'ed')).toBe(false);
  });
});

describe('buildNameKeywords', () => {
  it('makes the forename and surname separately searchable', () => {
    const keywords = buildNameKeywords([{ profileId: 'p1', fullName: 'Rowan Danbury' }]);
    const tokens = keywords.map((keyword) => keyword.token);

    expect(tokens).toContain('rowan');
    expect(tokens).toContain('danbury');
  });

  it('keeps each keyword attributed to its profile', () => {
    const keywords = buildNameKeywords([
      { profileId: 'p1', fullName: 'Rowan Danbury' },
      { profileId: 'p2', fullName: 'Marta Velkin' },
    ]);

    expect(keywords.find((keyword) => keyword.token === 'velkin')?.profileId).toBe('p2');
  });
});

describe('findNameMentions', () => {
  const keywords = buildNameKeywords([
    { profileId: 'p1', fullName: 'Rowan Danbury' },
    { profileId: 'p2', fullName: 'Marta Velkin' },
  ]);

  it('finds a mangled surname in running speech', () => {
    const mentions = findNameMentions('Thank you for coming in today, Mr Donbry.', keywords);

    expect(mentions).toHaveLength(1);
    expect(mentions[0].profileId).toBe('p1');
    expect(mentions[0].spoken).toBe('Donbry');
  });

  it('returns nothing for a line that names no one', () => {
    expect(findNameMentions('Can you describe what happened next?', keywords)).toEqual([]);
  });

  it('reports each distinct profile once for a line naming several people', () => {
    const mentions = findNameMentions('Rowan and Marta were both present.', keywords);

    expect(mentions.map((mention) => mention.profileId).sort()).toEqual(['p1', 'p2']);
  });
});
