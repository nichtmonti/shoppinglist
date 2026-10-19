// A stand-in for Chromium's `beforeinstallprompt`, which happy-dom never fires.
// `prompted` counts the install dialogs the app opened with it.
export function installEvent(): Event & { prompted: number } {
	const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
		prompted: 0,
		prompt: () => {
			event.prompted += 1;
			return Promise.resolve();
		},
		userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' })
	});
	return event;
}
