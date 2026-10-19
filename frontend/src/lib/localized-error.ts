/**
 * An error whose message is already localized user copy ([D-219]'s "you are on
 * N lists"); AsyncAction.run shows its message, and no other error's. A
 * plain module so the actions that throw it need not import a runes module.
 */
export class LocalizedError extends Error {}
