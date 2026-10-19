// A settings button whose sentence label may wrap at 200% text ([D-214]): a
// `sm` button in a row ([D-312]), so `sm`'s 36px is the floor and its inset
// keeps 44px to tap. `shrink max-w-full` undo the base's `shrink-0`, or the
// button runs off the card before its text can wrap.
export const WRAP_BUTTON_CLASS =
	'h-auto min-h-9 max-w-full shrink py-1.5 whitespace-normal text-balance';
