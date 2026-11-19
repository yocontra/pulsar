/**
 * PULSAR_NO_RATE_LIMIT=1 lifts the per-minute send caps (soak tests compress
 * hours of traffic into minutes). For tests only: it counts only with an
 * explicit PULSAR_HOME, so the daemon of a real install never runs uncapped.
 */
const unlimited =
	process.env.PULSAR_NO_RATE_LIMIT === "1" && !!process.env.PULSAR_HOME;

export const LIMITS = {
	maxBody: 64 * 1024,
	inboxCap: 50,
	sendsPerMinute: unlimited ? 1_000_000 : 60,
	broadcastsPerMinute: unlimited ? 1_000_000 : 6,
	/** All agents together may send this many times one agent's cap. */
	allAgentsFactor: 10,
	goneGraceMs: 60_000,
	messageRetentionMs: 14 * 24 * 3600_000,
	idleExitMs: 30 * 60_000,
	/** A user send to more agents than this needs a dry run's resolve token. */
	confirmAbove: 25,
	/** A resolve token is refused once the match moved by more than this share. */
	maxDrift: 0.05,
	resolveTokenMs: 10 * 60_000,
	maxResolveTokens: 500,
	maxSendIds: 10_000,
};

/** How often the daemon's background jobs run. */
export const INTERVALS = {
	sweepMs: 5000,
	subagentsMs: 15_000,
	refreshGitMs: 30_000,
	refreshPrsMs: 60_000,
	refreshModelsMs: 30_000,
	refreshMachineMs: 10 * 60_000,
	pruneMs: 3600_000,
	rateWindowMs: 60_000,
};
