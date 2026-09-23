const { matchAgainstProfiles } = require('./index');

describe('matchAgainstProfiles', () => {
  const profiles = [
    { _id: 'profile-1', fullName: 'Ada Lovelace', role: 'Engineer', embedding: [0.1, 0.2] },
    { _id: 'profile-2', fullName: 'Grace Hopper', role: 'Admiral', embedding: [0.3, 0.4] },
  ];

  it('returns no match without calling the recognition service when there are no profiles', async () => {
    const recognize = jest.fn();

    const result = await matchAgainstProfiles({ req: {}, file: {}, profiles: [], recognize });

    expect(recognize).not.toHaveBeenCalled();
    expect(result).toEqual({ recognized: false, bestMatch: null, scores: [] });
  });

  it('sends each profile as a candidate keyed by its id and resolves the winner back to a full identity', async () => {
    const recognize = jest.fn().mockResolvedValue({
      recognized: true,
      best_match: 'profile-2',
      scores: [
        { label: 'profile-1', score: 0.1 },
        { label: 'profile-2', score: 0.9 },
      ],
    });
    const req = { user: { id: 'user-1' } };
    const file = { path: '/tmp/clip.wav' };

    const result = await matchAgainstProfiles({ req, file, profiles, recognize });

    expect(recognize).toHaveBeenCalledWith({
      req,
      file,
      candidates: [
        { label: 'profile-1', embedding: [0.1, 0.2] },
        { label: 'profile-2', embedding: [0.3, 0.4] },
      ],
    });
    expect(result).toEqual({
      recognized: true,
      bestMatch: { id: 'profile-2', fullName: 'Grace Hopper', role: 'Admiral', score: 0.9 },
      scores: [
        { id: 'profile-1', fullName: 'Ada Lovelace', role: 'Engineer', score: 0.1 },
        { id: 'profile-2', fullName: 'Grace Hopper', role: 'Admiral', score: 0.9 },
      ],
    });
  });

  it('reports no best match when the service does not recognize the speaker', async () => {
    const recognize = jest.fn().mockResolvedValue({
      recognized: false,
      best_match: null,
      scores: [{ label: 'profile-1', score: 0.05 }],
    });

    const result = await matchAgainstProfiles({ req: {}, file: {}, profiles, recognize });

    expect(result.recognized).toBe(false);
    expect(result.bestMatch).toBeNull();
  });
});
