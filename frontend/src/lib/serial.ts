// One task at a time, in call order: each caller sees its own task's outcome,
// and a failed task does not stop the ones queued behind it.
export function serialQueue(): <T>(task: () => T | Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return (task) => {
		const run = tail.then(task);
		tail = run.catch(() => {});
		return run;
	};
}
