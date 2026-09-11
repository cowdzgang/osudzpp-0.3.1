// Challenge-phase endpoints.
//
// The challenge is played on the round's winning beatmap, so every route here starts
// from the recorded winner rather than from anything the caller sends. A player cannot
// nominate which map their score counts for.
//
// Reads are public: the leaderboard is the point of the phase. Writing a score is gated
// by requireCanChallenge — see the note on POST /scores for what that rule actually is.

import { Router } from 'express';
import type { Response } from 'express';
import { requireAuth, requireCanChallenge } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { findById as findRound, findCurrent } from '../repo/rounds.js';
import { findById as findSubmission } from '../repo/submissions.js';
import {
  findForUser,
  listForRound,
  qualifies,
  toApiChallengeScore,
  upsert,
} from '../repo/challengeScores.js';
import { scoreRound, toRoundPlay } from '../repo/dzpp.js';
import {
  ScoreNotFound,
  fetchUserRecentScoresForDifficulty,
} from '../services/osu.js';

const router = Router();

function fail(res: Response, err: unknown, where: string): void {
  console.error(`[challenge] ${where} failed:`, err instanceof Error ? err.message : err);
  res.status(503).json({ error: 'Database unavailable' });
}

/**
 * The round a request is about, and the entry the challenge is played on.
 *
 * roundId is optional so an archived round's leaderboard can be read; without it the
 * open round is used. The winner may be absent — a round can be archived from a phase
 * that never recorded one — and callers decide whether that is fatal.
 */
async function resolveChallenge(roundId: number | null) {
  const round = roundId === null ? await findCurrent() : await findRound(roundId);
  if (!round) return null;

  const winner =
    round.winning_submission_id === null ? null : await findSubmission(round.winning_submission_id);

  return { round, winner };
}

/** Parses ?roundId=. Returns undefined for a value that is not a positive integer. */
function readRoundId(raw: unknown): number | null | undefined {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

// GET /api/challenge/scores?roundId= — the leaderboard, best first.
//
// Ordering depends on the round's challenge requirement, because three of the four
// requirements are relative ('Top #1 Score', 'Best Accuracy', 'Lowest Miss Count') and
// so live in the order rather than in each row's qualified flag. See repo/
// challengeScores.ts. With no winner recorded there is no requirement to order by, so
// it falls back to score descending.
router.get('/scores', async (req, res) => {
  const roundId = readRoundId(req.query.roundId);
  if (roundId === undefined) {
    res.status(400).json({ error: 'roundId must be a positive integer' });
    return;
  }

  try {
    const context = await resolveChallenge(roundId);
    if (!context) {
      // No round to read. An empty leaderboard is the honest answer rather than a 404:
      // the dashboard asks for this on every load, including between rounds.
      res.json([]);
      return;
    }

    const rows = await listForRound(
      context.round.id,
      context.winner?.challenge_requirement ?? ''
    );
    // Provisional DZPP for the whole field, from the engine that will freeze it when the
    // round ends. rows is already in leaderboard order, which is exactly what scoreRound
    // needs — so the placements behind these numbers are the ones on screen.
    // Provisional DZPP: the round is still open so submission/vote sub-awards are not
    // queryable here. Both flags are false — the total is approximate by design.
    const provisional = new Map(
      scoreRound(rows.map((row) => toRoundPlay(row, false, false, '', context.winner?.challenge_requirement ?? ''))).map((result) => [result.userId, result.finalDzpp])
    );
    res.json(
      rows.map((row, i) => toApiChallengeScore(row, i + 1, provisional.get(row.user_id) ?? null))
    );
  } catch (err) {
    fail(res, err, 'leaderboard');
  }
});

// GET /api/challenge/my — the caller's own recorded score for the open round.
// 200 with a null body when they have not posted one, matching GET /votes/my.
// GET /api/challenge/scores/available — passed scores on the challenge beatmap
// that were set during the challenge phase. No database write happens here.
router.get('/scores/available', requireAuth, async (req, res) => {
  try {
    const context = await resolveChallenge(null);
    if (!context) {
      res.status(409).json({ error: 'No round is open' });
      return;
    }

    const { round, winner } = context;

    if (round.phase !== 'challenge') {
      res.status(409).json({
        error: `This round is in the ${round.phase} phase, so there is no challenge to play`,
      });
      return;
    }

    if (!winner) {
      res.status(409).json({
        error: 'This round has no recorded winner, so there is no challenge map',
      });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const challengeStartedAt = round.winner_approved_at;

    if (!challengeStartedAt) {
      res.status(409).json({
        error: 'This challenge has no recorded start time',
      });
      return;
    }

    const plays = await fetchUserRecentScoresForDifficulty(
      Number(winner.difficulty_id),
      Number(req.user.osu_id)
    );

    const availableScores = plays.filter((play) => {
      if (!play.endedAt) return false;
      return new Date(play.endedAt) >= challengeStartedAt;
    });

    res.json({
      scores: availableScores.map((play) => ({
        osuScoreId: play.osuScoreId,
        score: play.score,
        accuracy: play.accuracy,
        misses: play.misses,
        mods: play.mods,
        pp: play.pp,
        rank: play.rank,
        passed: play.passed,
        endedAt: play.endedAt,
      })),
    });
  } catch (err) {
    if (err instanceof ScoreNotFound) {
      res.json({ scores: [] });
      return;
    }

    fail(res, err, 'available challenge scores');
  }
});

// POST /api/challenge/scores — import the caller's selected osu! score for the winning map.
// The client sends { osuScoreId }; the server re-fetches the player's eligible scores
// and verifies that the selected score belongs to the authenticated session.
// read from the osu! API with the application's own token — a play on a public beatmap
// is public data, verified before this was built (docs/todo.txt E2).
//
// ELIGIBILITY: the country allowlist, plus an unambiguous per-player override.
//
// The allowlist half is the E2 decision — the challenge is for the same community as the
// rest of the platform, so accounts outside the enabled countries read the leaderboard and
// comment but do not compete for the prize.
//
// The override half closes what C5 opened. Splitting participation into submitting and
// voting left the challenge belonging to neither, so a player an administrator had blocked
// from BOTH could still play the winning map and win the month's prize. Blocked from both is
// the only unambiguous way those two flags say "this account does not take part", so it now
// refuses here too; granted both is that statement inverted, so it grants here too; and a
// block on just one capability is left to mean only what it says. The rule is
// canEnterChallenge in repo/users.ts, derived from the two stored flags rather than a third
// column, and it is tested there.
//
// This one reaches the osu! API too, and a player refreshing after every attempt is a
// reasonable thing to do — so the limit is generous but present.
// GET /api/challenge/scores/available — candidate scores the player can choose from.
// This is read-only. It finds recent Standard plays on the current challenge beatmap.
// The selected score is still verified again by POST /scores before it is stored.
const importLimit = rateLimit({ limit: 20, windowMs: 60_000, what: 'score imports' });

router.post('/scores', requireCanChallenge, importLimit, async (req, res) => {
  try {
    const context = await resolveChallenge(null);
    if (!context) {
      res.status(409).json({ error: 'No round is open' });
      return;
    }

    const { round, winner } = context;

    if (round.phase !== 'challenge') {
      res.status(409).json({
        error: `This round is in the ${round.phase} phase, so scores cannot be imported`,
      });
      return;
    }

    if (!winner) {
      res.status(409).json({
        error: 'This round has no recorded winner, so there is no challenge map',
      });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { osuScoreId } = req.body ?? {};

if (
  typeof osuScoreId !== 'number' ||
  !Number.isInteger(osuScoreId) ||
  osuScoreId <= 0
) {
  res.status(400).json({ error: 'A valid osuScoreId is required' });
  return;
}

let play;
try {
  const plays = await fetchUserRecentScoresForDifficulty(
    Number(winner.difficulty_id),
    Number(req.user.osu_id)
  );

  play = plays.find((candidate) => candidate.osuScoreId === osuScoreId);

  if (!play) {
    res.status(404).json({
      error: 'That score is not available in your eligible challenge scores.',
    });
    return;
  }
} catch (err) {
  if (err instanceof ScoreNotFound) {
    res.status(404).json({
      error: 'No eligible challenge scores were found.',
    });
    return;
  }

  console.error(
    '[challenge] osu! score fetch failed:',
    err instanceof Error ? err.message : err
  );
  res.status(503).json({
    error: 'Could not reach the osu! API',
  });
  return;
}

// Validate the authoritative osu! score.
if (play.osuUserId !== Number(req.user.osu_id)) {
  res.status(403).json({
    error: 'That score does not belong to your osu! account.',
  });
  return;
}

if (play.beatmapId !== Number(winner.difficulty_id)) {
  res.status(422).json({
    error: 'That score was not set on the challenge beatmap.',
  });
  return;
}

if (play.ruleset !== 'osu') {
  res.status(422).json({
    error: 'Only Standard scores can be imported for this challenge.',
  });
  return;
}

if (!play.passed) {
  res.status(422).json({
    error: 'Only passed scores can be imported.',
  });
  return;
}

    const challengeStartedAt = round.winner_approved_at;

    if (!play.endedAt || !challengeStartedAt) {
      res.status(422).json({
        error:
          'Your score has no timestamp and cannot be verified. Set a new score and try again.',
      });
      return;
    }

    if (new Date(play.endedAt) < challengeStartedAt) {
      res.status(422).json({
        error:
          'This score was set before the challenge started. ' +
          'Only scores set during the challenge phase count. ' +
          'Set a new score on the beatmap and import it again.',
      });
      return;
    }

    const row = await upsert({
      roundId: round.id,
      userId: req.user.id,
      score: play.score,
      accuracy: play.accuracy,
      misses: play.misses,
      mods: play.mods,
      pp: play.pp,
      qualified: qualifies(play, {
        modRequirement: winner.mod_requirement,
        challengeRequirement: winner.challenge_requirement,
      }),
      osuScoreId: play.osuScoreId === 0 ? null : play.osuScoreId,
    });

    res.json({ ok: true, score: toApiChallengeScore(row, 0, null) });
  } catch (err) {
    fail(res, err, 'import score');
  }
});

export default router;
