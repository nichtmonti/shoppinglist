// Registers a fake IndexedDB implementation on the node global so Dexie works in
// the vitest 'server' (node) project without a browser. Imported via vitest setupFiles.
import 'fake-indexeddb/auto';
