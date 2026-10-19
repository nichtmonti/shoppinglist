// The mirrored category templates (§6.12) keyed by slug, one derived store the
// views share instead of each rebuilding the map.
import { derived } from 'svelte/store';
import { categoryTemplates } from './data';
import { templateMap } from '#lib/categories.js';

export const templateLookup = derived(categoryTemplates, templateMap);
