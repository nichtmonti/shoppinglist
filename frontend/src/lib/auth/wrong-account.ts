// The re-auth's refusal to switch accounts ([D-76]). Its own module, with no
// imports, so the #lib/auth test mock can carry the real class.

/**
 * A re-auth signed in to a DIFFERENT account than the one this device holds
 * ([D-76]) and was not kept, since the device's local data and outbox belong
 * to the first. `orphan`: the sign-in had just CREATED that account (an OIDC
 * login no longer connected to this one), and it has been deleted again.
 */
export class WrongAccountError extends Error {
	readonly orphan: boolean;

	constructor(orphan: boolean) {
		super('signed in to a different account');
		this.name = 'WrongAccountError';
		this.orphan = orphan;
	}
}
