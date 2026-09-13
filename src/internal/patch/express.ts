import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from '@opentelemetry/instrumentation';
import { createHealthHandler } from '../../health.js';
import { log } from '../../log.js';
import { collectorHandler } from './collector.js';
import { errorMiddleware, isKitErrorMiddleware } from './error-emitters.js';
import { registerLoaderHook } from './loader-hook.js';
import { createRequestLog, isKitRequestLog } from './request-log.js';

/** Structural shapes of the express internals this reads - no express import. */
interface ExpressLayer {
  name?: string;
  path?: string;
  route?: { methods?: Record<string, boolean> } | null;
  handle?: unknown;
  match?(path: string): boolean;
}

interface ExpressRouter {
  stack: ExpressLayer[];
}

interface ExpressApp {
  use(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  post(...args: unknown[]): unknown;
  /** Express 4 only; Express 5 exposes the same router as `router`. */
  _router?: ExpressRouter;
  router?: ExpressRouter;
}

interface ExpressModule {
  application?: Record<string, unknown>;
  default?: { application?: Record<string, unknown> };
}

type BodyRequest = {
  body?: unknown;
  setEncoding?(encoding: string): unknown;
  on(event: string, listener: (chunk: unknown) => void): unknown;
};

/** Liveness only. Readiness means `health({ checks })`, which the service mounts itself. */
const HEALTH_PATHS = ['/health', '/api/health'] as const;
const COLLECTOR_PATH = '/api/client-errors';
const COLLECTOR_MAX_BYTES = 64 * 1024;

const isOff = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'off';

const origins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/**
 * Express 4 keeps the router on `_router` and THROWS from its `router` getter
 * ("'app.router' is deprecated!"); Express 5 has only `router`, built lazily on
 * first read. Reading `_router` first is what keeps one expression safe on both.
 */
const routerOf = (app: ExpressApp): ExpressRouter | undefined => {
  try {
    const router = app._router ?? app.router;
    return Array.isArray(router?.stack) ? router : undefined;
  } catch {
    return undefined;
  }
};

// Express's own query/init layers must stay ahead of ours: until `expressInit`
// has run, `res` is a bare ServerResponse with no `.status()` or `.json()`.
const INIT_LAYERS = new Set(['query', 'expressInit']);

const frontIndex = (stack: ExpressLayer[]): number => {
  let index = 0;
  while (index < stack.length && INIT_LAYERS.has(stack[index]?.name ?? '')) index += 1;
  return index;
};

/**
 * Whether a route the service registered itself already answers `path`, so the
 * auto-mounted one never shadows it. `layer.match` is the router's own matcher
 * (it only writes `layer.path`/`params`, which every request overwrites anyway).
 */
const claims = (stack: ExpressLayer[], method: string, path: string): boolean =>
  stack.some((layer) => {
    if (typeof layer.match !== 'function' || !layer.match(path)) return false;
    const methods = layer.route?.methods;
    if (methods) return Boolean(methods[method] || methods._all);
    const mounted = (layer.handle as { stack?: ExpressLayer[] } | undefined)?.stack;
    if (!Array.isArray(mounted)) return false;
    const matched = typeof layer.path === 'string' ? layer.path : '';
    return claims(mounted, method, path.slice(matched.length) || '/');
  });

// Introspection failure means the app wins: a shadowed readiness probe is worse
// than a missing auto-mounted one.
const handles = (app: ExpressApp, method: string, path: string): boolean => {
  const stack = routerOf(app)?.stack;
  if (!stack) return true;
  try {
    return claims(stack, method, path);
  } catch {
    log.debug({ path }, 'observability: express route introspection failed, skipping auto-mount');
    return true;
  }
};

const hasKitErrorMiddleware = (app: ExpressApp): boolean =>
  (routerOf(app)?.stack ?? []).some((layer) => isKitErrorMiddleware(layer.handle));

const hasKitRequestLog = (app: ExpressApp): boolean =>
  (routerOf(app)?.stack ?? []).some((layer) => isKitRequestLog(layer.handle));

/** `sendBeacon` posts text/plain, which no default body parser reads. */
const textBody =
  (maxBytes: number) =>
  (req: BodyRequest, _res: unknown, next: () => void): void => {
    if (req.body !== undefined) return next();
    let text = '';
    let dropped = false;
    req.setEncoding?.('utf8');
    req.on('data', (chunk) => {
      if (dropped) return;
      text += String(chunk);
      if (text.length > maxBytes) {
        dropped = true;
        text = '';
      }
    });
    req.on('end', () => {
      req.body = text;
      next();
    });
    req.on('error', () => next());
  };

const WIRED = Symbol.for('agentage.observability.express.wired');

/**
 * Everything a service used to wire by hand, mounted at `listen()` - the one
 * moment every route it owns is already registered, so ours can go around them:
 * the request log first (404s and rejections are requests too), the liveness
 * probes and the browser-error collector next, the error middleware last.
 * Each piece has an off switch, and a route the service registered itself always
 * wins. Idempotent: a second `listen()` on the same app changes nothing, and a
 * request log or error handler the service mounted by hand is found by its marker
 * symbol, so neither is ever mounted twice.
 */
export function autoWire(app: ExpressApp, env: NodeJS.ProcessEnv = process.env): void {
  const host = app as unknown as Record<symbol, unknown>;
  if (host[WIRED]) return;
  host[WIRED] = true;

  // Where the service's own stack ends; everything added past it is ours to move.
  const tail = routerOf(app)?.stack.length ?? 0;

  if (!isOff(env.OBS_REQUEST_LOG) && !hasKitRequestLog(app)) app.use(createRequestLog(log));

  if (!isOff(env.OBS_AUTO_HEALTH)) {
    const handler = createHealthHandler();
    for (const path of HEALTH_PATHS) {
      if (!handles(app, 'get', path)) app.get(path, handler);
    }
  }

  const allowOrigins = origins(env.OTEL_CLIENT_ERROR_ORIGINS);
  if (
    allowOrigins.length > 0 &&
    !isOff(env.OBS_COLLECTOR) &&
    !handles(app, 'post', COLLECTOR_PATH)
  ) {
    app.post(
      COLLECTOR_PATH,
      textBody(COLLECTOR_MAX_BYTES),
      collectorHandler(log, { allowOrigins })
    );
  }

  const stack = routerOf(app)?.stack;
  if (stack) {
    const added = stack.splice(tail);
    stack.splice(frontIndex(stack), 0, ...added);
  }

  if (!isOff(env.OBS_ERROR_MW) && !hasKitErrorMiddleware(app)) {
    app.use(errorMiddleware(log, { maskServerErrors: !isOff(env.OBS_MASK_5XX) }));
  }
}

const PATCHED = Symbol.for('agentage.observability.express.patched');

/**
 * Patch `listen` on the Application prototype, before any app exists: express
 * mixes the prototype's descriptors into each app at creation, so patching after
 * an app was built would miss it.
 */
export function patchExpressModule(moduleExports: ExpressModule): ExpressModule {
  const proto = (moduleExports?.application ?? moduleExports?.default?.application) as
    (Record<string, unknown> & { listen?: unknown }) | undefined;
  if (!proto || PATCHED in proto || typeof proto.listen !== 'function') return moduleExports;
  const original = proto.listen as (this: ExpressApp, ...args: unknown[]) => unknown;
  Object.defineProperty(proto, PATCHED, { value: true });
  proto.listen = function listen(this: ExpressApp, ...args: unknown[]): unknown {
    autoWire(this);
    return original.apply(this, args);
  };
  return moduleExports;
}

// Metadata on the hook itself; nothing reads it back.
const PATCH_VERSION = '1.0.0';

class ExpressAutoWire extends InstrumentationBase {
  constructor() {
    super('@agentage/observability/express', PATCH_VERSION, {});
  }

  init(): InstrumentationNodeModuleDefinition[] {
    return [
      new InstrumentationNodeModuleDefinition('express', ['>=4 <6'], (moduleExports) =>
        patchExpressModule(moduleExports as ExpressModule)
      ),
    ];
  }
}

let instrumentation: ExpressAutoWire | undefined;

/**
 * Hook express's module load, so `app.listen()` auto-wires. The hook is the same
 * one the OpenTelemetry instrumentations ride (require-in-the-middle for CJS, the
 * registered ESM loader hook for `import`) - no second mechanism to maintain, and
 * it sees express whichever way the service loads it. With every piece switched
 * off there is nothing to mount, so nothing is hooked either.
 */
export function installExpressPatch(env: NodeJS.ProcessEnv = process.env): boolean {
  const wanted =
    !isOff(env.OBS_REQUEST_LOG) ||
    !isOff(env.OBS_ERROR_MW) ||
    !isOff(env.OBS_AUTO_HEALTH) ||
    !isOff(env.OBS_COLLECTOR);
  if (!wanted || instrumentation) return false;
  registerLoaderHook();
  instrumentation = new ExpressAutoWire();
  instrumentation.enable();
  return true;
}
