// The stdio MCP server shape: one JSON-RPC frame on stdout, nothing else, ever.
// Spawned by stdio-guard.mjs under `node --import ../../dist/bootstrap.js`.
import { log } from '../../dist/index.js';

log.info({ route: '/smoke' }, 'a kit line, which belongs on stderr');
process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
