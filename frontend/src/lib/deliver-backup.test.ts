// Handing a backup to the user: the share sheet, or a download.
import { describe, it, expect, vi } from 'vitest';
import { BACKUP_FORMAT, BACKUP_VERSION, type ListBackup } from './backup';
import { deliverBackup } from './deliver-backup';

describe('deliverBackup', () => {
	const emptyBackup: ListBackup = {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exported_at: '2026-08-29T12:00:00.000Z',
		display_name: 'Wochenshop',
		categories: [],
		items: []
	};

	it('shares a File via navigator.share when file sharing is supported', async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		const canShare = vi.fn().mockReturnValue(true);
		vi.stubGlobal('navigator', { canShare, share });

		await deliverBackup(emptyBackup);

		expect(canShare).toHaveBeenCalled();
		const shareArg = share.mock.calls[0][0] as { files: File[] };
		expect(shareArg.files[0].name).toBe('wochenshop-2026-08-29.json');
		expect(shareArg.files[0].type).toBe('application/json');
	});

	// Dismissing the system share sheet rejects with AbortError: the user's
	// answer, not an export failure.
	it('resolves false, without throwing, when the share sheet is dismissed', async () => {
		const share = vi.fn().mockRejectedValue(new DOMException('Share canceled', 'AbortError'));
		vi.stubGlobal('navigator', { canShare: () => true, share });

		await expect(deliverBackup(emptyBackup)).resolves.toBe(false);
	});

	it('still rejects when sharing itself fails', async () => {
		const share = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
		vi.stubGlobal('navigator', { canShare: () => true, share });

		await expect(deliverBackup(emptyBackup)).rejects.toThrow('Denied');
	});

	it('falls back to an <a download> when sharing is unsupported', async () => {
		vi.stubGlobal('navigator', {});
		const click = vi.fn();
		const anchor = { href: '', download: '', click };
		vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
		const createObjectURL = vi.fn(() => 'blob:backup');
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

		await deliverBackup(emptyBackup);

		expect(click).toHaveBeenCalled();
		expect(anchor.download).toBe('wochenshop-2026-08-29.json');
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup');
	});
});
