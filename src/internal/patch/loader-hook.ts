import { register } from 'node:module';

let registered = false;

/**
 * The ESM loader hook that lets a module be patched after `import` resolved it -
 * `register()` (not the deprecated --experimental-loader flag) is the form that
 * survives Node 22 through 26. Registering it twice would wrap every module
 * twice, so both callers (the tracer and the express patch) come through here.
 */
export function registerLoaderHook(): void {
  if (registered) return;
  registered = true;
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
}
