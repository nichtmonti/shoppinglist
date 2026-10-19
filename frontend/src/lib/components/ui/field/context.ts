import { getContext, setContext } from 'svelte';

// What a Field tells the control inside it ([D-325]): whether it is invalid,
// and which line under it describes it. Input, Textarea and NativeSelect read
// it, so no caller wires aria by hand.
export type FieldState = { invalid: boolean; describedBy: string | undefined };

const KEY = Symbol('field');

export function setFieldState(state: FieldState): void {
	setContext(KEY, state);
}

export function fieldState(): FieldState | undefined {
	return getContext<FieldState | undefined>(KEY);
}
