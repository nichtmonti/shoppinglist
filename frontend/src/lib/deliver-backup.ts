// The browser half of export ([D-72]).
import { backupFileName, type ListBackup } from './backup';

/**
 * Hand a backup to the user: the share sheet where the platform can share
 * files, otherwise an `<a download>` click. Resolves false when the user
 * dismissed the share sheet, which is an answer, not a failure.
 */
export async function deliverBackup(backup: ListBackup): Promise<boolean> {
	const json = JSON.stringify(backup, null, 2);
	const fileName = backupFileName(backup.display_name, new Date(backup.exported_at));

	if (
		typeof navigator !== 'undefined' &&
		typeof navigator.canShare === 'function' &&
		typeof navigator.share === 'function'
	) {
		const file = new File([json], fileName, { type: 'application/json' });
		if (navigator.canShare({ files: [file] })) {
			try {
				await navigator.share({ files: [file] });
			} catch (error) {
				if (error instanceof Error && error.name === 'AbortError') return false;
				throw error;
			}
			return true;
		}
	}

	if (typeof document !== 'undefined') {
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName;
		a.click();
		URL.revokeObjectURL(url);
	}
	return true;
}
