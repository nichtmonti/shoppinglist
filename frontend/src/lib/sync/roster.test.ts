import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db';
import { refreshRoster, type RosterTransport, type RosterMember } from './roster';

describe('refreshRoster', () => {
	beforeEach(async () => {
		await db.roster.clear();
	});

	it('refreshRoster populates db.roster from the transport', async () => {
		const listId = 'list1';
		const members: RosterMember[] = [
			{ account: 'user1', nickname: 'User One', joined: '2024-01-01T00:00:00Z' },
			{ account: 'user2', nickname: 'User Two', joined: '2024-01-02T00:00:00Z' }
		];
		const transport: RosterTransport = vi.fn().mockResolvedValue(members);
		const result = await refreshRoster(listId, transport);
		expect(result).toEqual(members);
		const roster = await db.roster.toArray();
		expect(roster).toHaveLength(2);
		expect(roster[0]).toEqual({
			id: 'list1_user1',
			list: listId,
			account: 'user1',
			nickname: 'User One',
			joined: '2024-01-01T00:00:00Z'
		});
		expect(roster[1]).toEqual({
			id: 'list1_user2',
			list: listId,
			account: 'user2',
			nickname: 'User Two',
			joined: '2024-01-02T00:00:00Z'
		});
	});

	it("refreshRoster REPLACES the list's roster (clear+put)", async () => {
		const listId = 'list1';
		// Seed 3 stale roster entries for the list
		await db.roster.bulkPut([
			{
				id: 'list1_old1',
				list: listId,
				account: 'old1',
				nickname: 'Old One',
				joined: '2023-01-01T00:00:00Z'
			},
			{
				id: 'list1_old2',
				list: listId,
				account: 'old2',
				nickname: 'Old Two',
				joined: '2023-01-02T00:00:00Z'
			},
			{
				id: 'list1_old3',
				list: listId,
				account: 'old3',
				nickname: 'Old Three',
				joined: '2023-01-03T00:00:00Z'
			}
		]);
		expect(await db.roster.where('list').equals(listId).count()).toBe(3);

		const members: RosterMember[] = [
			{ account: 'user1', nickname: 'User One', joined: '2024-01-01T00:00:00Z' }
		];
		const transport: RosterTransport = vi.fn().mockResolvedValue(members);
		await refreshRoster(listId, transport);
		const roster = await db.roster.where('list').equals(listId).toArray();
		expect(roster).toHaveLength(1);
		expect(roster[0].account).toBe('user1');
	});

	it('refreshRoster only affects the target list', async () => {
		const listA = 'listA';
		const listB = 'listB';
		// Seed roster entries for both lists
		await db.roster.bulkPut([
			{
				id: 'listA_user1',
				list: listA,
				account: 'user1',
				nickname: 'User One',
				joined: '2024-01-01T00:00:00Z'
			},
			{
				id: 'listA_user2',
				list: listA,
				account: 'user2',
				nickname: 'User Two',
				joined: '2024-01-02T00:00:00Z'
			},
			{
				id: 'listB_user3',
				list: listB,
				account: 'user3',
				nickname: 'User Three',
				joined: '2024-01-03T00:00:00Z'
			},
			{
				id: 'listB_user4',
				list: listB,
				account: 'user4',
				nickname: 'User Four',
				joined: '2024-01-04T00:00:00Z'
			}
		]);

		const members: RosterMember[] = [
			{ account: 'new1', nickname: 'New One', joined: '2024-02-01T00:00:00Z' }
		];
		const transport: RosterTransport = vi.fn().mockResolvedValue(members);
		await refreshRoster(listA, transport);

		const rosterA = await db.roster.where('list').equals(listA).toArray();
		const rosterB = await db.roster.where('list').equals(listB).toArray();
		expect(rosterA).toHaveLength(1);
		expect(rosterA[0].account).toBe('new1');
		expect(rosterB).toHaveLength(2);
		expect(rosterB.map((r) => r.account)).toEqual(['user3', 'user4']);
	});

	it('returns the members passed through', async () => {
		const listId = 'list1';
		const members: RosterMember[] = [
			{ account: 'user1', nickname: 'User One', joined: '2024-01-01T00:00:00Z' },
			{ account: 'user2', nickname: 'User Two', joined: '2024-01-02T00:00:00Z' }
		];
		const transport: RosterTransport = vi.fn().mockResolvedValue(members);
		const result = await refreshRoster(listId, transport);
		expect(result).toBe(members);
	});
});
