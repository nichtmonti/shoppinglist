// The sync engine's public surface (§8, [D-220]): everything the app may call,
// and the only module outside the engine it may import from. The rest of
// #lib/sync is the engine's own business, and lint refuses a deep import from
// anywhere else (eslint.shared.config.js says which files are exempt and why).
//
// How the app uses it:
//
//   1. Lifecycle. The root layout calls mountSync() once, with the notices
//      it raises (#lib/state/sync-notices), and unmountSync() on the way out; the list route calls setActiveList() as navigation moves.
//      Nothing else starts a loop or opens a realtime subscription.
//   2. Writes. An item or category changes ONLY through the four outbox calls
//      below. They apply the edit locally and queue it for the push route
//      (§8.2–8.3); nothing writes those Dexie tables directly, and nothing
//      posts to the push route itself.
//   3. Server routes. Mutations that are online-only (create, join, clone,
//      import, leave, clear-history) go straight to their route, then tell the
//      engine what changed: pullFromServer() to pull what the route made,
//      purgeList() when the list is gone for this account, applyServerPatch()
//      when the route changed fields on rows the device already holds.
//   4. Members. refreshRoster() when a surface needs the current member names
//      now rather than at the engine's own triggers (§7.4).
//   5. Status. `leading` says whether this tab sends, `syncNow()` asks the tab
//      that does for a cycle, and querySyncHealth() says what it last saw of
//      the server (#lib/state/sync-status reads the three, [D-296]). The
//      outbox is read through queryPendingOps(): the engine's tables and
//      meta keys are its own.
//   6. Notices. Conflicts, refusals and vanished lists come back as raw data
//      through the SyncNotices callbacks mountSync() takes; the app words them.
export { mountSync, unmountSync, setActiveList, pullFromServer } from './mount';

export { createRecord, updateRecord, deleteRecord, restoreRecord, inOneCommit } from './outbox';
export type { SyncCollection, SyncNotices, ConflictNotice, DeniedNotice } from './types';

export { purgeList } from './purge';
export { applyServerPatch } from './apply';

export { refreshRoster } from './roster';
export { scalar } from './record';

export { leading } from './leading';
export { syncNow } from './loop';
export { NO_HEALTH, type SyncHealth, type SyncFailure } from './health';
export {
	queryPendingOps,
	querySyncHealth,
	querySyncedRow,
	queryShelfCounts,
	queryOpenRows,
	queryLatestCheckOffs,
	queryRememberedRows,
	type ShelfCounts
} from './queries';
