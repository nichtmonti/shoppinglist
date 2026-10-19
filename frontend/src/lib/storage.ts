// §8.8: ask for persistent storage on first load. Best-effort: the grant is a
// browser heuristic, and boot never waits on the answer.
export async function requestPersistentStorage(): Promise<boolean> {
	const storage = globalThis.navigator?.storage;
	if (!storage?.persist) return false;
	try {
		return await storage.persist();
	} catch {
		return false;
	}
}
